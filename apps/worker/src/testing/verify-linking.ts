/**
 * Regression tests for the linking handshake.
 *
 * Run with: npm run verify:linking --workspace=@wa/worker
 *
 * Three bugs made linking hang on "Logging in…" forever, and none of them
 * were visible to the type checker or to any single-step test. Each is pinned
 * here against a real database.
 *
 * The WhatsApp socket is still not exercised — that needs a live account — but
 * every state transition around it is, which is where all three bugs lived.
 */

import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql } from 'drizzle-orm';
import { createDb, asSystem, schema, type Database } from '@wa/db';
import { MIGRATIONS_FOLDER, startPostgres } from '@wa/db/testing';
import { createLogger, generateKey } from '@wa/core';
import { useDbAuthState } from '@wa/wa';
import { expirePairingArtifacts } from '../jobs/expire-pairing-artifacts';
import { maintainSessions, resetLinkCooldowns } from '../jobs/maintain-sessions';
import type { WorkerContext } from '../context';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(
      `  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    );
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/**
 * Stands in for WaManager, recording what the job asked for.
 *
 * The jobs only ever call has/get/drop/startLinking/resume/statuses, so a
 * recorder is enough to assert the decisions without a socket.
 */
function recordingManager() {
  const open = new Map<string, string>();
  const linked: { id: string; phoneE164: string | null }[] = [];
  const resumed: string[] = [];
  const dropped: string[] = [];

  return {
    calls: { linked, resumed, dropped },
    open,
    get size() {
      return open.size;
    },
    has: (id: string) => open.has(id),
    get: (id: string) => (open.has(id) ? ({ isConnected: true } as never) : undefined),
    statuses: () => Object.fromEntries(open),
    startLinking: async (s: { id: string; phoneE164: string | null }) => {
      linked.push({ id: s.id, phoneE164: s.phoneE164 });
      open.set(s.id, 'pairing');
      return {} as never;
    },
    resume: async (s: { id: string }) => {
      resumed.push(s.id);
      open.set(s.id, 'connected');
      return {} as never;
    },
    drop: async (id: string) => {
      dropped.push(id);
      open.delete(id);
    },
    unlink: async () => undefined,
    closeAll: async () => undefined,
  };
}

async function main(): Promise<void> {
  console.log('Starting Postgres…');
  const pg = await startPostgres();
  const owner = createDb({ url: pg.ownerUrl, maxConnections: 2 });
  const app = createDb({ url: pg.appUrl, maxConnections: 6 });
  await migrate(owner.db, { migrationsFolder: MIGRATIONS_FOLDER });

  const db: Database = app.db;
  const log = createLogger({ level: 'error', base: { service: 'verify-linking' } });
  const encryptionKey = generateKey();

  const userId = `u_${randomUUID()}`;
  await asSystem(owner.db, async (tx) => {
    await tx.insert(schema.users).values({ id: userId, email: 'link@example.com' });
    await tx.insert(schema.settings).values({ userId });
  });

  const makeCtx = (wa: ReturnType<typeof recordingManager>): WorkerContext =>
    ({
      env: { PLATFORM_MAX_NEW_CONTACTS_24H: 120, LOG_LEVEL: 'error' },
      log,
      db,
      sql: app.sql,
      wa,
      workerId: 'verify-linking',
    }) as unknown as WorkerContext;

  const newSession = async (over: Partial<typeof schema.waSessions.$inferInsert> = {}) =>
    asSystem(db, async (tx) => {
      const r = await tx
        .insert(schema.waSessions)
        .values({ userId, status: 'pending', ...over })
        .returning({ id: schema.waSessions.id });
      return r[0]!.id;
    });

  /** One reconciliation pass, with the retry cooldown out of the way. */
  const tick = async (ctx: WorkerContext, signal: AbortSignal) => {
    resetLinkCooldowns();
    return maintainSessions.run(ctx, signal);
  };

  const readSession = async (id: string) =>
    asSystem(db, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.waSessions)
        .where(eq(schema.waSessions.id, id))
        .limit(1);
      return rows[0]!;
    });

  try {
    // -----------------------------------------------------------------------
    section('Bug 1 — auth state must survive the reconnect after pairing');

    // WhatsApp closes the socket with `restartRequired` the instant a device
    // links, and the reconnect used to re-read the encrypted blob from
    // Postgres. The credentials written at that moment were on a debounce, so
    // the reconnect read pre-pairing state, came up unregistered, and the
    // phone sat on "Logging in…" forever.
    const authSession = await newSession({ phoneE164: '+919000000101' });

    const first = await useDbAuthState({ db, sessionId: authSession, encryptionKey });
    check(
      'a fresh session starts unregistered',
      first.state.creds.registered === false,
      first.state.creds.registered,
    );

    // Stand in for what Baileys does when a pairing completes.
    first.state.creds.registered = true;
    first.state.creds.me = { id: '919000000101:1@s.whatsapp.net', name: 'Test' };
    await first.saveCreds();

    const afterSave = await readSession(authSession);
    check(
      'credentials are written immediately, not on a debounce',
      afterSave.credsEncrypted !== null,
      { hasCreds: afterSave.credsEncrypted !== null },
    );

    // What a reconnect would read if it went back to the database.
    const reread = await useDbAuthState({ db, sessionId: authSession, encryptionKey });
    check(
      'a re-read sees the registered credentials',
      reread.state.creds.registered === true,
      reread.state.creds.registered,
    );
    check(
      'and the linked identity survives the round trip',
      reread.state.creds.me?.id === '919000000101:1@s.whatsapp.net',
      reread.state.creds.me,
    );

    // Signal keys are still coalesced — that is the one thing the debounce was
    // for, and losing it would mean an encrypt-and-UPDATE per message part.
    const keySession = await newSession({ phoneE164: '+919000000102' });
    const keyed = await useDbAuthState({ db, sessionId: keySession, encryptionKey });
    keyed.state.keys.set({ 'pre-key': { '1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } } });
    const immediately = await readSession(keySession);
    check(
      'signal keys are still coalesced rather than written per call',
      immediately.credsEncrypted === null,
      { wroteImmediately: immediately.credsEncrypted !== null },
    );
    await keyed.flush();
    const flushed = await readSession(keySession);
    check('and flush() forces them out', flushed.credsEncrypted !== null);

    // -----------------------------------------------------------------------
    section('Bug 2 — a pairing session must not have its socket dropped');

    // maintain-sessions tears down sockets the database no longer wants. A
    // session mid-pairing is in neither the "pending" nor the "connected" set,
    // so it was dropped about five seconds after the code was issued — before
    // anyone could type eight characters.
    const pairingSession = await newSession({ phoneE164: '+919000000103' });
    const wa1 = recordingManager();
    const ctx1 = makeCtx(wa1);

    await tick(ctx1, new AbortController().signal);
    check(
      'a pending session with a number starts linking',
      wa1.calls.linked.some((l) => l.id === pairingSession),
      wa1.calls.linked,
    );
    check(
      'and is asked for a pairing code for that number',
      wa1.calls.linked.find((l) => l.id === pairingSession)?.phoneE164 ===
        '+919000000103',
      wa1.calls.linked,
    );

    // Now the handshake is under way: status 'pairing', a code on the row.
    await asSystem(db, (tx) =>
      tx
        .update(schema.waSessions)
        .set({
          status: 'pairing',
          pairingCode: 'ABCD-1234',
          pairingCodeExpiresAt: new Date(Date.now() + 150_000),
          credsEncrypted: 'partial-handshake',
        })
        .where(eq(schema.waSessions.id, pairingSession)),
    );

    await tick(ctx1, new AbortController().signal);
    await tick(ctx1, new AbortController().signal);
    check(
      'the socket survives repeated ticks while the user types',
      !wa1.calls.dropped.includes(pairingSession),
      wa1.calls.dropped,
    );
    check('and is still open', wa1.has(pairingSession));

    // -----------------------------------------------------------------------
    section('Bug 3 — an expired code must not strand the session');

    // The expiry job reset the row to 'pending' but left the partial
    // handshake in creds_encrypted. maintain-sessions only picks up a
    // 'pending' row whose credentials are NULL, so the row matched nothing and
    // the UI showed "Starting" forever.
    await asSystem(db, (tx) =>
      tx
        .update(schema.waSessions)
        .set({ pairingCodeExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.waSessions.id, pairingSession)),
    );

    await expirePairingArtifacts.run(ctx1, new AbortController().signal);
    const expired = await readSession(pairingSession);
    check('the expired code is cleared', expired.pairingCode === null);
    check('the session drops back to pending', expired.status === 'pending', expired.status);
    check(
      'and the half-finished handshake is discarded with it',
      expired.credsEncrypted === null,
      { credsEncrypted: expired.credsEncrypted },
    );
    check(
      'the user is told why',
      expired.lastError === 'The code expired before it was used',
      expired.lastError,
    );

    // The point of all that: the row is eligible again without intervention.
    const wa2 = recordingManager();
    await tick(makeCtx(wa2), new AbortController().signal);
    check(
      'so the next tick starts a fresh attempt by itself',
      wa2.calls.linked.some((l) => l.id === pairingSession),
      wa2.calls.linked,
    );

    // A number that genuinely linked must never have its credentials wiped by
    // that same reset — this is the guard that makes it safe.
    const linkedSession = await newSession({
      phoneE164: '+919000000104',
      status: 'pairing',
      credsEncrypted: 'real-credentials',
      linkedAt: new Date(Date.now() - 86_400_000),
    });
    await expirePairingArtifacts.run(ctx1, new AbortController().signal);
    const stillLinked = await readSession(linkedSession);
    check(
      'a previously linked session keeps its credentials',
      stillLinked.credsEncrypted === 'real-credentials',
      stillLinked.credsEncrypted,
    );

    // -----------------------------------------------------------------------
    section('Bug 4 — the window between "socket opened" and "code issued"');

    // The state a real session was found stranded in for four days:
    // status 'pending', credentials present (the socket writes a partial
    // handshake within milliseconds of opening), no code yet.
    //
    // The old job asked three separate questions — pending-without-credentials,
    // connected, pairing — and this fell between all three. So its socket was
    // dropped five seconds in, and nothing ever picked the row up again.
    const stranded = await newSession({
      phoneE164: '+919000000107',
      status: 'pending',
      credsEncrypted: 'partial-handshake-from-a-dead-socket',
    });

    const wa8 = recordingManager();
    await tick(makeCtx(wa8), new AbortController().signal);
    check(
      'a pending session WITH a partial handshake is picked up',
      wa8.calls.linked.some((l) => l.id === stranded),
      wa8.calls.linked,
    );
    check(
      'and is not mistaken for a linked session to reconnect',
      !wa8.calls.resumed.includes(stranded),
      wa8.calls.resumed,
    );

    // The other half: once a socket is open, nothing may restart it, whatever
    // the row says. This is what protects a user mid-way through typing.
    const wa9 = recordingManager();
    const ctx9 = makeCtx(wa9);
    await tick(ctx9, new AbortController().signal);
    const startedOnce = wa9.calls.linked.length;
    await tick(ctx9, new AbortController().signal);
    await tick(ctx9, new AbortController().signal);
    check(
      'an open socket is never restarted by a later pass',
      wa9.calls.linked.length === startedOnce,
      { startedOnce, after: wa9.calls.linked.length },
    );
    check(
      'nor dropped while its session still wants one',
      wa9.calls.dropped.length === 0,
      wa9.calls.dropped,
    );

    // And the cooldown has to actually hold a failing session off, or a socket
    // that dies instantly becomes a reconnect loop.
    const wa10 = recordingManager();
    const ctx10 = makeCtx(wa10);
    await maintainSessions.run(ctx10, new AbortController().signal);
    const firstPass = wa10.calls.linked.length;
    wa10.open.clear(); // simulate every socket dying at once
    await maintainSessions.run(ctx10, new AbortController().signal);
    check(
      'a session whose socket just died is not retried immediately',
      wa10.calls.linked.length === firstPass,
      { firstPass, afterDeath: wa10.calls.linked.length },
    );

    // -----------------------------------------------------------------------
    section('QR linking');

    // A QR link has no number up front: WhatsApp reports which number scanned
    // it. The job must therefore accept a NULL phone for this method, and only
    // for this method.
    const qrSession = await newSession({ linkMethod: 'qr' });
    const wa3 = recordingManager();
    await tick(makeCtx(wa3), new AbortController().signal);
    check(
      'a QR session with no number still starts linking',
      wa3.calls.linked.some((l) => l.id === qrSession),
      wa3.calls.linked,
    );
    check(
      'and is not asked for a pairing code',
      wa3.calls.linked.find((l) => l.id === qrSession)?.phoneE164 === null,
      wa3.calls.linked,
    );

    const codeNoNumber = await newSession({ linkMethod: 'pairing_code' });
    const wa4 = recordingManager();
    await tick(makeCtx(wa4), new AbortController().signal);
    check(
      'a pairing-code session with no number is left alone',
      !wa4.calls.linked.some((l) => l.id === codeNoNumber),
      wa4.calls.linked,
    );

    // -----------------------------------------------------------------------
    section('Reconnecting a linked session');

    const connected = await newSession({
      phoneE164: '+919000000105',
      status: 'disconnected',
      credsEncrypted: 'creds',
      linkedAt: new Date(),
    });
    const wa5 = recordingManager();
    await tick(makeCtx(wa5), new AbortController().signal);
    check(
      'a disconnected session with credentials is resumed',
      wa5.calls.resumed.includes(connected),
      wa5.calls.resumed,
    );

    // A throttled number stays offline until its hold expires — reconnecting
    // into a cap is what turns it into a ban.
    const throttled = await newSession({
      phoneE164: '+919000000106',
      status: 'throttled',
      credsEncrypted: 'creds',
      linkedAt: new Date(),
      throttledUntil: new Date(Date.now() + 3_600_000),
    });
    const wa6 = recordingManager();
    await tick(makeCtx(wa6), new AbortController().signal);
    check(
      'a throttled session is not resumed while the hold stands',
      !wa6.calls.resumed.includes(throttled),
      wa6.calls.resumed,
    );

    await asSystem(db, (tx) =>
      tx
        .update(schema.waSessions)
        .set({ throttledUntil: new Date(Date.now() - 1_000) })
        .where(eq(schema.waSessions.id, throttled)),
    );
    const wa7 = recordingManager();
    await tick(makeCtx(wa7), new AbortController().signal);
    const released = await readSession(throttled);
    check(
      'and is released once it does expire',
      released.status === 'disconnected' && released.throttledUntil === null,
      { status: released.status, until: released.throttledUntil },
    );
  } finally {
    await app.sql.end({ timeout: 5 }).catch(() => undefined);
    await owner.sql.end({ timeout: 5 }).catch(() => undefined);
    await pg.stop();
  }

  console.log(
    `\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nVerification crashed:', err);
  process.exit(1);
});

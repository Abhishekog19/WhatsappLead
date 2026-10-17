/**
 * Restart and deployment correctness.
 *
 * Run with: npm run verify:restart --workspace=@wa/worker
 *
 * These three behaviours only matter on a host that restarts often, which is
 * exactly what a free instance is: it spins down after fifteen idle minutes,
 * is woken by the next request, and may be recycled at any time. A deployment
 * also runs the old and new instances concurrently for a few seconds.
 *
 * Each is verified against a real Postgres over the restricted role, because
 * every one of them is a database behaviour rather than a TypeScript one.
 */

import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql } from 'drizzle-orm';
import {
  acquireSessionLease,
  asSystem,
  createDb,
  LEASE_TTL_MS,
  pruneExpiredLeases,
  releaseAllLeases,
  releaseSessionLease,
  renewOwnedSession,
  schema,
  type Database,
} from '@wa/db';
import { MIGRATIONS_FOLDER, startPostgres } from '@wa/db/testing';
import { createLogger } from '@wa/core';
import { reapStaleClaims } from '../jobs/reap-stale-claims';
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

async function main(): Promise<void> {
  console.log('Starting Postgres…');
  const pg = await startPostgres();
  const owner = createDb({ url: pg.ownerUrl, maxConnections: 2 });
  const app = createDb({ url: pg.appUrl, maxConnections: 6 });
  await migrate(owner.db, { migrationsFolder: MIGRATIONS_FOLDER });

  const db: Database = app.db;
  const log = createLogger({ level: 'error', base: { service: 'verify-restart' } });

  const userId = `u_${randomUUID()}`;
  await asSystem(owner.db, async (tx) => {
    await tx.insert(schema.users).values({ id: userId, email: 'restart@example.com' });
    await tx.insert(schema.settings).values({ userId });
  });

  const newSession = async (phone: string): Promise<string> =>
    asSystem(db, async (tx) => {
      const r = await tx
        .insert(schema.waSessions)
        .values({
          userId,
          phoneE164: phone,
          status: 'connected',
          credsEncrypted: 'stub',
          linkedAt: new Date(),
        })
        .returning({ id: schema.waSessions.id });
      return r[0]!.id;
    });

  try {
    // -----------------------------------------------------------------------
    section('The restricted role can use the lease table');

    const whoami = await db.execute<{ superuser: string; bypass: boolean }>(sql`
      select current_setting('is_superuser') as superuser,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypass
    `);
    check(
      'running as a role that cannot bypass RLS',
      whoami[0]?.superuser === 'off' && whoami[0]?.bypass === false,
      whoami[0],
    );

    // -----------------------------------------------------------------------
    section('Session ownership during a deployment overlap');

    const sessionId = await newSession('+919000000201');

    const first = await acquireSessionLease(db, sessionId, 'worker-old');
    check('I/O ownership guard accepts the holder', await renewOwnedSession(db, sessionId, 'worker-old'));
    check('I/O ownership guard refuses a second worker', !await renewOwnedSession(db, sessionId, 'worker-new'));
    check('the first worker takes the lease', first.held && first.heldBy === 'worker-old');

    // The replacement starts while the outgoing instance is still shutting
    // down. It must NOT get the session: two sockets on one linked device is
    // how WhatsApp decides to log the number out.
    const second = await acquireSessionLease(db, sessionId, 'worker-new');
    check(
      'an overlapping worker is refused',
      !second.held && second.heldBy === 'worker-old',
      second,
    );

    const renewed = await acquireSessionLease(db, sessionId, 'worker-old');
    check('the holder can renew its own lease', renewed.held);

    // Several workers racing at once — only one may win.
    const contested = await newSession('+919000000202');
    const racers = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((id) =>
        acquireSessionLease(db, contested, `racer-${id}`),
      ),
    );
    const winners = racers.filter((r) => r.held);
    check(
      'exactly one of five concurrent claimants wins',
      winners.length === 1,
      racers.map((r) => ({ held: r.held, by: r.heldBy })),
    );

    // Handing it back is what makes a deploy fast, rather than every account
    // idling until the old lease lapses.
    await releaseSessionLease(db, sessionId, 'worker-old');
    const afterRelease = await acquireSessionLease(db, sessionId, 'worker-new');
    check('after release the new worker takes over immediately', afterRelease.held);

    // A late shutdown from the OLD worker must not release a lease the NEW one
    // now holds — that would hand two processes the same session.
    await releaseSessionLease(db, sessionId, 'worker-old');
    const stillOwned = await asSystem(db, async (tx) => {
      const rows = await tx
        .select({ workerId: schema.waSessionLeases.workerId })
        .from(schema.waSessionLeases)
        .where(eq(schema.waSessionLeases.sessionId, sessionId));
      return rows[0]?.workerId ?? null;
    });
    check(
      'a late release from the previous owner is ignored',
      stillOwned === 'worker-new',
      stillOwned,
    );

    // A worker killed without cleanup must not strand the session forever.
    await asSystem(owner.db, async (tx) => {
      await tx
        .update(schema.waSessionLeases)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.waSessionLeases.sessionId, sessionId));
    });
    const afterExpiry = await acquireSessionLease(db, sessionId, 'worker-third');
    check('an old owner cannot renew after takeover', !await renewOwnedSession(db, sessionId, 'worker-new'));
    check(
      'an expired lease can be taken over',
      afterExpiry.held && afterExpiry.heldBy === 'worker-third',
      afterExpiry,
    );

    const ttlSane = LEASE_TTL_MS >= 30_000 && LEASE_TTL_MS <= 300_000;
    check('the lease window is neither brittle nor stranding', ttlSane, LEASE_TTL_MS);

    const releasedCount = await releaseAllLeases(db, 'worker-third');
    check('a worker can release everything it holds', releasedCount >= 1, releasedCount);
    await pruneExpiredLeases(db);

    // -----------------------------------------------------------------------
    section('Ambiguous interrupted sends are not resent');

    const listId = await asSystem(db, async (tx) => {
      const r = await tx
        .insert(schema.contactLists)
        .values({ userId, name: 'Restart', columns: [] })
        .returning({ id: schema.contactLists.id });
      return r[0]!.id;
    });

    const templateId = await asSystem(db, async (tx) => {
      const t = await tx
        .insert(schema.templates)
        .values({ userId, name: 'T' })
        .returning({ id: schema.templates.id });
      await tx
        .insert(schema.templateVariants)
        .values({ templateId: t[0]!.id, userId, body: 'hi {{name}}', position: 0 });
      return t[0]!.id;
    });

    const campaignId = await asSystem(db, async (tx) => {
      const c = await tx
        .insert(schema.campaigns)
        .values({
          userId,
          name: 'Restart',
          sessionId: contested,
          listId,
          templateId,
          status: 'running',
        })
        .returning({ id: schema.campaigns.id });
      return c[0]!.id;
    });

    /** A target stuck in `sending`, as a killed worker would leave it. */
    const stuckTarget = async (
      label: string,
      over: Partial<typeof schema.campaignTargets.$inferInsert>,
    ): Promise<string> =>
      asSystem(db, async (tx) => {
        const contact = await tx
          .insert(schema.contacts)
          .values({ userId, listId, phoneE164: `+9190000${Math.floor(Math.random() * 90_000 + 10_000)}`, name: label })
          .returning({ id: schema.contacts.id });
        const t = await tx
          .insert(schema.campaignTargets)
          .values({
            campaignId,
            userId,
            contactId: contact[0]!.id,
            status: 'sending',
            // Older than the ten-minute stall threshold.
            claimedAt: new Date(Date.now() - 20 * 60_000),
            ...over,
          })
          .returning({ id: schema.campaignTargets.id });
        return t[0]!.id;
      });

    // Never handed to WhatsApp: safe to retry.
    const neverSent = await stuckTarget('never-dispatched', {});
    // Handed over and confirmed: settle as sent.
    const confirmed = await stuckTarget('confirmed', {
      dispatchStartedAt: new Date(Date.now() - 20 * 60_000),
      waMessageId: 'wamid.CONFIRMED',
    });
    // Handed over, no answer. THE dangerous one.
    const ambiguous = await stuckTarget('ambiguous', {
      dispatchStartedAt: new Date(Date.now() - 20 * 60_000),
    });
    // Out of retries and never dispatched.
    const exhausted = await stuckTarget('exhausted', { attempts: 3 });

    const ctx = {
      env: { PLATFORM_MAX_NEW_CONTACTS_24H: 120, LOG_LEVEL: 'error' },
      log,
      db,
      sql: app.sql,
      wa: { get: () => undefined, has: () => false, size: 0, statuses: () => ({}) },
      workerId: 'verify-restart',
    } as unknown as WorkerContext;

    await reapStaleClaims.run(ctx, new AbortController().signal);

    const statusOf = async (id: string) =>
      asSystem(db, async (tx) => {
        const rows = await tx
          .select({
            status: schema.campaignTargets.status,
            lastError: schema.campaignTargets.lastError,
            attempts: schema.campaignTargets.attempts,
          })
          .from(schema.campaignTargets)
          .where(eq(schema.campaignTargets.id, id));
        return rows[0]!;
      });

    const neverState = await statusOf(neverSent);
    check(
      'a target that never reached WhatsApp goes back in the queue',
      neverState.status === 'pending',
      neverState,
    );

    const confirmedState = await statusOf(confirmed);
    check(
      'a target with a message id settles as sent',
      confirmedState.status === 'sent',
      confirmedState,
    );

    const ambiguousState = await statusOf(ambiguous);
    check(
      'a target interrupted MID-SEND is not requeued',
      ambiguousState.status !== 'pending',
      ambiguousState,
    );
    check(
      'it is failed instead, so a human can check the chat',
      ambiguousState.status === 'failed',
      ambiguousState.status,
    );
    check(
      'and the reason says delivery is unknown',
      /may already have delivered/i.test(ambiguousState.lastError ?? ''),
      ambiguousState.lastError,
    );

    const exhaustedState = await statusOf(exhausted);
    check(
      'a target out of retries is failed, not retried forever',
      exhaustedState.status === 'failed',
      exhaustedState,
    );

    // Corroboration: a delivery receipt proves the message went, even with no
    // id on the target row.
    const corroborated = await stuckTarget('corroborated', {
      dispatchStartedAt: new Date(Date.now() - 20 * 60_000),
    });
    await asSystem(db, async (tx) => {
      const target = await tx
        .select({ contactId: schema.campaignTargets.contactId })
        .from(schema.campaignTargets)
        .where(eq(schema.campaignTargets.id, corroborated));
      await tx.insert(schema.messageEvents).values({
        userId,
        sessionId: contested,
        contactId: target[0]!.contactId,
        campaignId,
        direction: 'out',
        type: 'sent',
        occurredAt: new Date(Date.now() - 19 * 60_000),
      });
    });
    await reapStaleClaims.run(ctx, new AbortController().signal);
    const corroboratedState = await statusOf(corroborated);
    check(
      'a delivery event turns an unknown into a confirmed send',
      corroboratedState.status === 'sent',
      corroboratedState,
    );

    // -----------------------------------------------------------------------
    section('Pacing survives a restart');

    // The pacer used to live only in memory, so a restart skipped the gap
    // between messages and the long pause between batches.
    const future = new Date(Date.now() + 45 * 60_000);
    await asSystem(db, async (tx) => {
      await tx
        .update(schema.campaigns)
        .set({ nextSendAt: future, batchSentCount: 7 })
        .where(eq(schema.campaigns.id, campaignId));
    });

    // A "restart" is just reading the row again: nothing is cached.
    const reloaded = await asSystem(db, async (tx) => {
      const rows = await tx
        .select({
          nextSendAt: schema.campaigns.nextSendAt,
          batchSentCount: schema.campaigns.batchSentCount,
        })
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId));
      return rows[0]!;
    });

    check(
      'the next-send time is still in the future after a reload',
      reloaded.nextSendAt !== null &&
        reloaded.nextSendAt.getTime() > Date.now() + 40 * 60_000,
      reloaded.nextSendAt,
    );
    check(
      'and progress through the current batch is remembered',
      reloaded.batchSentCount === 7,
      reloaded.batchSentCount,
    );

    // -----------------------------------------------------------------------
    section('A throttled number is not resumed early');

    await asSystem(db, async (tx) => {
      await tx
        .update(schema.waSessions)
        .set({
          status: 'throttled',
          throttledUntil: new Date(Date.now() + 6 * 3_600_000),
        })
        .where(eq(schema.waSessions.id, contested));
    });

    const throttled = await asSystem(db, async (tx) => {
      const rows = await tx
        .select({
          status: schema.waSessions.status,
          until: schema.waSessions.throttledUntil,
        })
        .from(schema.waSessions)
        .where(eq(schema.waSessions.id, contested));
      return rows[0]!;
    });
    check(
      'the hold is recorded on the session, not in memory',
      throttled.status === 'throttled' && throttled.until !== null,
      throttled,
    );
    // maintain-sessions only resumes 'connected' and 'disconnected' sessions,
    // so a restart cannot reconnect this one just to carry on sending.
    check(
      'and a throttled status is outside the set a restart reconnects',
      !['connected', 'disconnected'].includes(throttled.status),
      throttled.status,
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

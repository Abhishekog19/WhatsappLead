/**
 * Authentication under enforced row-level security.
 *
 * Run with: npm run verify:auth --workspace=@wa/web
 *
 * The adapter is exercised over a NON-superuser connection, which is the only
 * configuration that proves anything: on a superuser connection row-level
 * security is skipped entirely and a broken adapter passes every test.
 *
 * This suite exists because the original adapter was handed a plain connection
 * while `users` carries FORCE row-level security. Sign-in happens before a
 * tenant identity exists, so its policies matched nothing — invisible on the
 * superuser connection used in development, fatal on the restricted role used
 * in production.
 */

import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { and, eq, sql } from 'drizzle-orm';
import { createDb, schema, withUser } from '@wa/db';
import { MIGRATIONS_FOLDER, startPostgres } from '@wa/db/testing';
import { canSignInByEmail, createTrustedAdapter } from '../server/auth-adapter';

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

const TABLES = {
  usersTable: schema.users,
  accountsTable: schema.authAccounts,
  sessionsTable: schema.authSessions,
  verificationTokensTable: schema.verificationTokens,
  authenticatorsTable: schema.authenticators,
} as const;

async function main(): Promise<void> {
  console.log('Starting Postgres…');
  const pg = await startPostgres();
  const owner = createDb({ url: pg.ownerUrl, maxConnections: 2 });
  const app = createDb({ url: pg.appUrl, maxConnections: 4 });

  try {
    await migrate(owner.db, { migrationsFolder: MIGRATIONS_FOLDER });

    // -----------------------------------------------------------------------
    section('The restricted role really is restricted');

    const attrs = await app.db.execute<{ superuser: string; bypass: boolean }>(sql`
      select current_setting('is_superuser') as superuser,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypass
    `);
    check(
      'the connection under test cannot bypass RLS',
      attrs[0]?.superuser === 'off' && attrs[0]?.bypass === false,
      attrs[0],
    );

    // -----------------------------------------------------------------------
    section('A plain adapter cannot sign anyone in');

    // The bug, reproduced. Without trusted access the policies on `users`
    // match nothing, and this is what that looks like from the outside.
    const plainInsertBlocked = await app.db
      .insert(schema.users)
      .values({ id: `u_${randomUUID()}`, email: 'plain@example.com' })
      .then(() => false)
      .catch(() => true);
    check(
      'an untrusted insert into users is refused by the policy',
      plainInsertBlocked,
    );

    const plainRead = await app.db.select().from(schema.users);
    check(
      'and an untrusted read of users returns nothing',
      plainRead.length === 0,
      plainRead.length,
    );

    // -----------------------------------------------------------------------
    section('The trusted adapter completes a full sign-in');

    const adapter = createTrustedAdapter(app.db, TABLES);

    const methods = [
      'createUser',
      'getUser',
      'getUserByEmail',
      'getUserByAccount',
      'updateUser',
      'linkAccount',
      'createSession',
      'getSessionAndUser',
      'updateSession',
      'deleteSession',
    ] as const;
    const missing = methods.filter(
      (m) => typeof (adapter as Record<string, unknown>)[m] !== 'function',
    );
    check('the adapter exposes the methods Auth.js needs', missing.length === 0, missing);

    // First sign-in: Auth.js creates the user, links the Google account,
    // then opens a session. Each step is a separate adapter call.
    const email = `alice+${randomUUID().slice(0, 8)}@example.com`;
    check('a first-time OAuth profile is allowed before its DB user exists', await canSignInByEmail(app.db, email));
    const created = await adapter.createUser!({
      id: randomUUID(),
      email,
      emailVerified: null,
      name: 'Alice',
      image: null,
    });
    check('createUser writes the row', Boolean(created?.id), created?.id);

    const providerAccountId = `google-${randomUUID().slice(0, 8)}`;
    await adapter.linkAccount!({
      userId: created.id,
      type: 'oidc',
      provider: 'google',
      providerAccountId,
    });

    const byAccount = await adapter.getUserByAccount!({
      provider: 'google',
      providerAccountId,
    });
    check(
      'a returning user is found by their Google account',
      byAccount?.id === created.id,
      byAccount?.id ?? null,
    );

    const byEmail = await adapter.getUserByEmail!(email);
    check('and by email', byEmail?.id === created.id);

    const sessionToken = randomUUID();
    await adapter.createSession!({
      sessionToken,
      userId: created.id,
      expires: new Date(Date.now() + 30 * 86_400_000),
    });

    const sessionAndUser = await adapter.getSessionAndUser!(sessionToken);
    // The join onto `users` is the step that failed silently before, and it is
    // the one every authenticated request depends on.
    check(
      'getSessionAndUser joins users successfully',
      sessionAndUser?.user?.id === created.id,
      sessionAndUser?.user?.id ?? null,
    );
    check(
      'and returns the session it was given',
      sessionAndUser?.session?.sessionToken === sessionToken,
    );

    // -----------------------------------------------------------------------
    section('Escalation does not outlive the call');

    // app.system is set transaction-locally inside each adapter call. If it
    // leaked, a later query on the same pooled connection would see every
    // tenant's rows — the exact failure the transaction-local flag prevents.
    const afterAdapter = await app.db.select().from(schema.users);
    check(
      'a later query on the same pool still sees nothing',
      afterAdapter.length === 0,
      afterAdapter.length,
    );

    // -----------------------------------------------------------------------
    section('Tenant isolation is unchanged by any of this');

    const bob = await adapter.createUser!({
      id: randomUUID(),
      email: `bob+${randomUUID().slice(0, 8)}@example.com`,
      emailVerified: null,
      name: 'Bob',
      image: null,
    });

    // Settings rows, as the createUser event writes them.
    for (const id of [created.id, bob.id]) {
      await app.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.system', 'on', true)`);
        await tx.insert(schema.settings).values({ userId: id });
      });
    }

    await withUser(app.db, created.id, (tx) =>
      tx.insert(schema.contacts).values({
        userId: created.id,
        phoneE164: '+919000000001',
        name: "Alice's lead",
      }),
    );
    await withUser(app.db, bob.id, (tx) =>
      tx.insert(schema.contacts).values({
        userId: bob.id,
        phoneE164: '+919000000002',
        name: "Bob's lead",
      }),
    );

    const aliceSees = await withUser(app.db, created.id, (tx) =>
      tx.select().from(schema.contacts),
    );
    check(
      'each user still sees only their own contacts',
      aliceSees.length === 1 && aliceSees[0]?.name === "Alice's lead",
      aliceSees.map((c) => c.name),
    );

    const aliceSeesUsers = await withUser(app.db, created.id, (tx) =>
      tx.select({ id: schema.users.id }).from(schema.users),
    );
    check(
      'and only their own user row',
      aliceSeesUsers.length === 1 && aliceSeesUsers[0]?.id === created.id,
      aliceSeesUsers.length,
    );

    // -----------------------------------------------------------------------
    section('Suspension is enforced, and fails closed');

    await owner.db
      .update(schema.users)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.users.id, bob.id));

    // Mirrors the signIn callback: a trusted read of the suspension flag.
    const readSuspension = async (userId: string): Promise<Date | null | 'unreadable'> => {
      try {
        const rows = await app.db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.system', 'on', true)`);
          return tx
            .select({ suspendedAt: schema.users.suspendedAt })
            .from(schema.users)
            .where(eq(schema.users.id, userId))
            .limit(1);
        });
        return rows[0] ? rows[0].suspendedAt : 'unreadable';
      } catch {
        return 'unreadable';
      }
    };

    check('a suspended user is visible as suspended', (await readSuspension(bob.id)) instanceof Date);
    check('the real sign-in guard refuses a suspended email', !await canSignInByEmail(app.db, bob.email!));
    const suspendedToken = randomUUID();
    await adapter.createSession!({ sessionToken: suspendedToken, userId: bob.id, expires: new Date(Date.now() + 60_000) });
    check('a suspended user cannot reuse an existing session', await adapter.getSessionAndUser!(suspendedToken) === null);
    check('an active user is not', (await readSuspension(created.id)) === null);

    // The old failure mode: the same read WITHOUT trusted access returns no
    // row, which the previous callback treated as "not suspended".
    const untrusted = await app.db
      .select({ suspendedAt: schema.users.suspendedAt })
      .from(schema.users)
      .where(eq(schema.users.id, bob.id))
      .limit(1);
    check(
      'an untrusted suspension read sees no row at all',
      untrusted.length === 0,
      untrusted.length,
    );
    console.log(
      '       (which the previous callback read as "not suspended" and allowed)',
    );

    // -----------------------------------------------------------------------
    section('Sign-out revokes the session');

    await adapter.deleteSession!(sessionToken);
    const afterDelete = await adapter.getSessionAndUser!(sessionToken);
    check('a deleted session no longer resolves', !afterDelete);

    const remaining = await owner.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.authSessions)
      .where(and(eq(schema.authSessions.userId, created.id)));
    check('and is gone from the table', Number(remaining[0]?.n) === 0, remaining[0]);
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

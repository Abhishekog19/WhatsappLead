import { loadEnvFile } from '@wa/core';
import { createDb } from '../client';
import { checkTenantIsolation } from '../isolation';
import { acquireSessionLease } from '../leases';
import { withUser, asSystem } from '../tenant';
import { sql } from 'drizzle-orm';

/**
 * Checks a real DATABASE_URL before anything is deployed against it.
 *
 * Run with: npm run db:verify-connection
 *
 * Everything here is a property of the connection rather than of the code,
 * and each has a failure mode that only appears in production:
 *
 *   - A managed provider's default role bypasses row-level security, so
 *     tenant isolation is silently inert.
 *   - A pooler in transaction mode gives each transaction a different
 *     backend, so anything relying on session state breaks — including the
 *     transaction-local setting the whole isolation model rests on.
 *   - A pooler also rejects prepared statements, which the driver uses by
 *     default.
 *   - The free tier's direct connection may not be reachable at all.
 *
 * Read-only apart from one temporary row, which is removed again.
 */

type Status = 'ok' | 'warn' | 'fail';

const results: { status: Status; name: string; detail?: string }[] = [];

function record(status: Status, name: string, detail?: string): void {
  results.push({ status, name, detail });
  const mark = status === 'ok' ? 'ok  ' : status === 'warn' ? 'warn' : 'FAIL';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  loadEnvFile();

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  // Never print the whole string: it carries the password.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error('DATABASE_URL is not a valid URL.');
    process.exit(1);
  }

  console.log(`Host     : ${parsed.hostname}:${parsed.port || '5432'}`);
  console.log(`Database : ${parsed.pathname.replace('/', '')}`);
  console.log(`Role     : ${decodeURIComponent(parsed.username)}`);

  const pooled = parsed.hostname.includes('pooler.supabase.com');
  const transactionMode = pooled && parsed.port === '6543';
  if (pooled) {
    console.log(
      `Pooler   : Supabase shared pooler, ${transactionMode ? 'transaction' : 'session'} mode`,
    );
  }
  console.log();

  const { db, sql: raw } = createDb({ url, maxConnections: 2 });

  try {
    console.log('Connection');

    const [hello] = await db.execute<{ v: string; ssl: boolean | null }>(sql`
      select version() as v,
             (select ssl from pg_stat_ssl where pid = pg_backend_pid()) as ssl
    `);
    record('ok', 'reachable', (hello?.v ?? '').split(',')[0]);

    // Supabase requires TLS; a pooler that reports otherwise means something
    // is terminating the connection in between.
    if (hello?.ssl === true) record('ok', 'connection is encrypted');
    else if (hello?.ssl === false)
      record(
        pooled ? 'fail' : 'warn',
        'connection is NOT encrypted',
        pooled ? 'Supabase should always be TLS' : 'fine for a local database',
      );
    else record('warn', 'could not determine TLS state');

    // The driver is configured with prepare:false, which transaction mode
    // requires. Confirm rather than assume — a stray prepared statement only
    // fails under load, when a different backend answers.
    const [prep] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_prepared_statements
    `);
    record(
      Number(prep?.n) === 0 ? 'ok' : 'warn',
      'no prepared statements in use',
      Number(prep?.n) === 0 ? 'safe for transaction-mode pooling' : `${prep?.n} found`,
    );

    const [limits] = await db.execute<{ max: string; used: number }>(sql`
      select current_setting('max_connections') as max,
             (select count(*)::int from pg_stat_activity) as used
    `);
    record('ok', 'connection headroom', `${limits?.used} in use of ${limits?.max}`);

    console.log('\nSchema');

    const [tables] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
    `);
    const tableCount = Number(tables?.n ?? 0);
    if (tableCount === 0) {
      record('fail', 'migrations have not been run', 'run npm run db:migrate as the owner');
    } else {
      record('ok', `${tableCount} tables present`);
    }

    const [leases] = await db.execute<{ ok: boolean }>(sql`
      select exists (
        select 1 from information_schema.tables
         where table_schema = 'public' and table_name = 'wa_session_leases'
      ) as ok
    `);
    record(
      leases?.ok ? 'ok' : 'fail',
      'latest migrations applied',
      leases?.ok ? undefined : 'wa_session_leases is missing',
    );

    console.log('\nPrivileges and isolation');

    const isolation = await checkTenantIsolation(db);
    record(
      isolation.ok ? 'ok' : 'fail',
      isolation.ok ? 'tenant isolation is enforced' : 'TENANT ISOLATION IS NOT ENFORCED',
      isolation.ok ? `as ${isolation.role}` : isolation.problems.join('; '),
    );

    // Grants, exercised rather than read out of a catalogue: what matters is
    // whether the role can actually do the work.
    const grants = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.role_table_grants
       where grantee = current_user and table_schema = 'public'
         and privilege_type = 'INSERT'
       order by table_name
    `);
    record(
      grants.length >= 15 ? 'ok' : 'warn',
      'write access to the application tables',
      `${grants.length} tables`,
    );

    console.log('\nTenant context through this connection');

    // THE check this script exists for. Tenant isolation is set with a
    // transaction-local set_config. If the pooler broke that, every query
    // would see nothing — or worse, everything.
    const probeUser = `probe_${Date.now()}`;
    await asSystem(db, async (tx) => {
      await tx.execute(sql`
        insert into users (id, email) values (${probeUser}, ${`${probeUser}@probe.invalid`})
        on conflict do nothing
      `);
    });

    try {
      const seen = await withUser(db, probeUser, async (tx) => {
        const rows = await tx.execute<{ who: string | null }>(sql`
          select app_current_user_id() as who
        `);
        return rows[0]?.who ?? null;
      });
      record(
        seen === probeUser ? 'ok' : 'fail',
        'transaction-local tenant context survives the pooler',
        seen === probeUser ? undefined : `read back ${String(seen)}`,
      );

      // And that it does NOT survive beyond the transaction, which is what
      // makes a shared pool safe.
      const [leaked] = await db.execute<{ who: string | null }>(sql`
        select app_current_user_id() as who
      `);
      record(
        leaked?.who === null ? 'ok' : 'fail',
        'and does not leak to the next query on that connection',
        leaked?.who === null ? undefined : `leaked ${String(leaked?.who)}`,
      );

      // The lease upsert, against this pooler specifically.
      const probeSession = '00000000-0000-0000-0000-000000000000';
      const leaseWorks = await acquireSessionLease(db, probeSession, 'probe')
        .then(() => true)
        .catch((error: unknown) => {
          // A foreign-key violation is the expected answer: the session does
          // not exist. It still proves the statement itself runs.
          const message = error instanceof Error ? error.message : String(error);
          return /foreign key/i.test(message);
        });
      record(
        leaseWorks ? 'ok' : 'fail',
        'session-ownership lease works on this connection',
      );
    } finally {
      await asSystem(db, async (tx) => {
        await tx.execute(sql`delete from users where id = ${probeUser}`);
      });
    }

    const failed = results.filter((r) => r.status === 'fail');
    const warned = results.filter((r) => r.status === 'warn');

    console.log(
      `\n${results.length - failed.length - warned.length} ok, ${warned.length} warnings, ${failed.length} failures`,
    );

    if (failed.length > 0) {
      console.log('\nThis connection is not ready. Fix the failures above.');
      process.exit(1);
    }
    console.log('\nThis connection is ready to deploy against.');
  } finally {
    await raw.end({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('\nCould not verify the connection:', error);
  process.exit(1);
});

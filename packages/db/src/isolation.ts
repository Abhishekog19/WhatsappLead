import { sql } from 'drizzle-orm';
import type { Database } from './client';

/**
 * Startup check: is row-level security actually in force for this connection?
 *
 * This exists because of a failure mode that is both easy to hit and
 * completely silent. Postgres exempts superusers and any role with BYPASSRLS
 * from row-level security — `force row level security` does not apply to
 * them. So an application connecting as a superuser gets every policy
 * skipped, every query succeeds, every test of normal behaviour passes, and
 * tenant isolation is simply gone.
 *
 * It is easy to hit because the official Postgres Docker image creates
 * POSTGRES_USER as a superuser, and because `postgres://postgres@localhost`
 * is what most people reach for locally.
 *
 * There is no way to detect this from the application's own behaviour — the
 * data looks right, because the application also filters by user_id. It only
 * shows up the day a `where` clause is missing. So it is asserted explicitly
 * at boot instead.
 */

export interface IsolationStatus {
  ok: boolean;
  role: string;
  isSuperuser: boolean;
  bypassRls: boolean;
  /** Tenant tables that are missing RLS or FORCE RLS. */
  unprotectedTables: string[];
  problems: string[];
}

export async function checkTenantIsolation(db: Database): Promise<IsolationStatus> {
  const rows = await db.execute<{
    role: string;
    is_superuser: string;
    bypass_rls: boolean | null;
  }>(sql`
    select current_user                                  as role,
           current_setting('is_superuser')               as is_superuser,
           (select rolbypassrls from pg_roles
             where rolname = current_user)               as bypass_rls
  `);

  const row = rows[0];
  const isSuperuser = row?.is_superuser === 'on';
  const bypassRls = row?.bypass_rls === true;

  const unprotected = await db.execute<{ relname: string }>(sql`
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relname in (
         'settings', 'wa_sessions', 'contact_lists', 'contacts', 'suppressions',
         'templates', 'template_variants', 'campaigns', 'campaign_targets',
         'new_contact_sends', 'throttle_events', 'message_events', 'audit_log',
         'users'
       )
       and not (c.relrowsecurity and c.relforcerowsecurity)
     order by c.relname
  `);

  const unprotectedTables = unprotected.map((r) => r.relname);
  const problems: string[] = [];

  if (isSuperuser) {
    problems.push(
      `The database role "${row?.role}" is a SUPERUSER, so Postgres skips every row-level security policy. ` +
        'One user\'s data is not isolated from another\'s. Connect as a non-superuser role instead.',
    );
  }
  if (bypassRls) {
    problems.push(
      `The database role "${row?.role}" has BYPASSRLS, which disables tenant isolation. ` +
        'Run: ALTER ROLE "' + (row?.role ?? '') + '" NOBYPASSRLS;',
    );
  }
  if (unprotectedTables.length > 0) {
    problems.push(
      `These tables are missing row-level security: ${unprotectedTables.join(', ')}. ` +
        'Has migration 0001_rls.sql been applied?',
    );
  }

  return {
    ok: problems.length === 0,
    role: row?.role ?? 'unknown',
    isSuperuser,
    bypassRls,
    unprotectedTables,
    problems,
  };
}

/**
 * Same check, but fatal.
 *
 * Called at worker startup. Refusing to boot is the right response: a
 * platform whose entire safety story is "one account can never affect
 * another" should not run at all when that is not true.
 */
export async function assertTenantIsolation(db: Database): Promise<IsolationStatus> {
  const status = await checkTenantIsolation(db);
  if (!status.ok) {
    throw new Error(
      `Tenant isolation is not enforced.\n\n${status.problems
        .map((p) => `  - ${p}`)
        .join('\n')}\n\nSee packages/db/drizzle/0001_rls.sql.`,
    );
  }
  return status;
}

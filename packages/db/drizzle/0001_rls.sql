-- Row-Level Security.
--
-- Defence in depth. Every query the application makes is already scoped by
-- user_id in TypeScript; this makes a forgotten `where` clause a Postgres
-- error rather than a cross-tenant data leak. It is the mechanism behind the
-- product rule that one user's data can never affect another's sending.
--
-- How it works at runtime:
--   the app opens a transaction, runs
--     select set_config('app.user_id', $1, true)
--   and every policy below compares user_id against current_setting(...).
--   The `true` makes the setting transaction-local, so a pooled connection
--   cannot leak one request's identity into the next.
--
-- Note `force row level security` below: it makes the policies apply to the
-- table owner too, which is the role every process here connects as. So there
-- is no implicit bypass — not for the web app, not for the worker, not for a
-- psql session. The single deliberate escape hatch is the `app.system` flag
-- described further down, set only by asSystem() in @wa/db/tenant.

--> statement-breakpoint
-- Returns the caller's user id, or NULL when unset. STABLE so the planner may
-- cache it within a statement.
create or replace function app_current_user_id() returns text
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '') $$;

--> statement-breakpoint
-- True only inside asSystem(). Also transaction-local, so it cannot survive
-- into the next borrower of a pooled connection.
create or replace function app_is_system() returns boolean
  language sql stable
  as $$ select coalesce(current_setting('app.system', true) = 'on', false) $$;

--> statement-breakpoint
-- The role the web app and worker connect as. Created only if missing so the
-- migration is safe to re-run against an existing database.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'wa_app') then
    create role wa_app nologin;
  end if;
end
$$;

--> statement-breakpoint
grant usage on schema public to wa_app;
--> statement-breakpoint
grant select, insert, update, delete on all tables in schema public to wa_app;
--> statement-breakpoint
alter default privileges in schema public
  grant select, insert, update, delete on tables to wa_app;

--> statement-breakpoint
-- Tables keyed directly by user_id: the policy is the same for all of them.
--
-- Two permissive policies per table. Postgres ORs permissive policies, so a
-- row is visible if it belongs to the caller OR the caller is the worker
-- running a cross-tenant maintenance pass. Splitting them keeps the tenant
-- rule readable and makes every escalation one grep away (`app.system`).
do $$
declare
  t text;
begin
  foreach t in array array[
    'settings',
    'wa_sessions',
    'contact_lists',
    'contacts',
    'suppressions',
    'templates',
    'template_variants',
    'campaigns',
    'campaign_targets',
    'new_contact_sends',
    'throttle_events',
    'message_events'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    -- FORCE applies the policy to the table owner too, so a forgotten filter
    -- is caught even when connected as the role that created the tables.
    execute format('alter table %I force row level security', t);

    execute format('drop policy if exists %I on %I', t || '_tenant_isolation', t);
    execute format(
      'create policy %I on %I using (user_id = app_current_user_id()) '
      'with check (user_id = app_current_user_id())',
      t || '_tenant_isolation', t
    );

    execute format('drop policy if exists %I on %I', t || '_system_access', t);
    execute format(
      'create policy %I on %I using (app_is_system()) with check (app_is_system())',
      t || '_system_access', t
    );
  end loop;
end
$$;

--> statement-breakpoint
-- users: a person may read and update only their own row. The worker reads
-- across users to honour suspensions before it sends anything.
alter table users enable row level security;
--> statement-breakpoint
alter table users force row level security;
--> statement-breakpoint
drop policy if exists users_self on users;
--> statement-breakpoint
create policy users_self on users
  using (id = app_current_user_id())
  with check (id = app_current_user_id());
--> statement-breakpoint
drop policy if exists users_system_access on users;
--> statement-breakpoint
create policy users_system_access on users
  using (app_is_system())
  with check (app_is_system());

--> statement-breakpoint
-- audit_log is append-only: insert and read, never update or delete. The
-- worker appends to it as well, for actions it takes on a user's behalf.
alter table audit_log enable row level security;
--> statement-breakpoint
alter table audit_log force row level security;
--> statement-breakpoint
drop policy if exists audit_log_read_own on audit_log;
--> statement-breakpoint
create policy audit_log_read_own on audit_log
  for select using (user_id = app_current_user_id() or app_is_system());
--> statement-breakpoint
drop policy if exists audit_log_append on audit_log;
--> statement-breakpoint
create policy audit_log_append on audit_log
  for insert with check (user_id = app_current_user_id() or app_is_system());
--> statement-breakpoint
revoke update, delete on audit_log from wa_app;

--> statement-breakpoint
-- Auth.js tables are touched by the adapter BEFORE a session exists, so they
-- cannot be policed by app.user_id. They hold no tenant business data and are
-- reachable only by the server-side adapter.
-- (auth_accounts, auth_sessions, verification_tokens, authenticators)

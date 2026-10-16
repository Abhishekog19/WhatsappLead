import { createDb } from '../client';
import { loadEnvFile } from '@wa/core';

/**
 * Creates the unprivileged role the application connects as.
 *
 * Run with: npm run db:setup-role --workspace=@wa/db
 *
 * The Docker deployment does this in infra/postgres-init.sh, which runs once
 * when the data volume is first initialised. A managed database — Neon,
 * Supabase, RDS — has no such hook, so this is the equivalent for those, and
 * for a Postgres installed locally.
 *
 * Why it is needed at all: Postgres exempts superusers and BYPASSRLS roles
 * from row-level security, and `force row level security` does not change
 * that. An application connecting as one has every tenant-isolation policy
 * silently skipped — all the queries still return the right rows, because the
 * application also filters by user_id, so nothing looks wrong until the first
 * forgotten `where` clause serves one account another account's data.
 *
 * Connect as the owner to run this; point DATABASE_URL at wa_app afterwards.
 */
async function main(): Promise<void> {
  loadEnvFile();

  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. It must point at the owner role.');
    process.exit(1);
  }

  const password = process.env.POSTGRES_APP_PASSWORD;
  if (!password) {
    console.error(
      'POSTGRES_APP_PASSWORD is not set.\n\n' +
        'Add it to .env — this becomes the password for the wa_app role:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(18).toString(\'base64url\'))"',
    );
    process.exit(1);
  }

  const { sql } = createDb({ url, maxConnections: 1 });

  try {
    const [who] = await sql<{ role: string; superuser: string }[]>`
      select current_user as role, current_setting('is_superuser') as superuser
    `;
    console.log(`Connected as ${who?.role} (superuser: ${who?.superuser}).`);

    // Idempotent: safe to re-run after a password rotation or a failed
    // attempt. The attributes are set unconditionally so an existing role
    // created by hand without them is corrected rather than left wrong.
    await sql.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = 'wa_app') then
          create role wa_app login nosuperuser nobypassrls nocreatedb nocreaterole;
        end if;
      end
      $$;
    `);
    await sql`alter role wa_app with login nosuperuser nobypassrls password ${sql.unsafe(`'${password.replace(/'/g, "''")}'`)}`;

    // Grants, in case migration 0001 ran before the role existed. Repeating
    // them is harmless and makes the order the two were run in irrelevant.
    await sql.unsafe('grant usage on schema public to wa_app');
    await sql.unsafe(
      'grant select, insert, update, delete on all tables in schema public to wa_app',
    );
    await sql.unsafe(
      'alter default privileges in schema public grant select, insert, update, delete on tables to wa_app',
    );
    // The broad grant above must not undo the append-only audit policy.
    await sql.unsafe('revoke update, delete on audit_log from wa_app');

    const [check] = await sql<{ bypass: boolean; superuser: boolean }[]>`
      select rolbypassrls as bypass, rolsuper as superuser
        from pg_roles where rolname = 'wa_app'
    `;

    if (check?.bypass || check?.superuser) {
      console.error(
        '\nwa_app still bypasses row-level security. Isolation would not be enforced.',
      );
      process.exit(1);
    }

    console.log('\nwa_app is ready: LOGIN, NOSUPERUSER, NOBYPASSRLS.');
    console.log('Point DATABASE_URL at it, keeping the host and database the same:');
    console.log('  DATABASE_URL=postgres://wa_app:<POSTGRES_APP_PASSWORD>@<host>/<db>');
    console.log('\nThe worker will confirm isolation is enforced on its next boot.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  // Driver errors may include the ALTER ROLE statement and its password.
  console.error('Failed to set up the app role. Check owner privileges and connection settings.');
  process.exit(1);
});

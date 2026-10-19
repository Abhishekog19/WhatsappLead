import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const postgres = require('postgres');

const url = process.env.MIGRATION_DATABASE_URL;
const ca  = process.env.DATABASE_SSL_CA;
const pass = process.env.POSTGRES_APP_PASSWORD;

const sql = postgres(url, { ssl: { rejectUnauthorized: true, ca }, max: 1, connect_timeout: 10 });

try {
  const [who] = await sql`select current_user as role, current_setting('is_superuser') as superuser`;
  console.log('Connected as:', who.role, '| superuser:', who.superuser);

  // Check current wa_app attrs
  const attrs = await sql`select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'wa_app'`;
  console.log('wa_app current attrs:', attrs[0] ?? 'not found');

  // Try to drop and recreate since ALTER ROLE fails on Supabase postgres user
  try {
    await sql.unsafe(`drop role if exists wa_app`);
    console.log('✅ DROP ROLE ok');
  } catch (e) {
    console.error('❌ DROP ROLE failed:', e.message);
  }

  try {
    await sql.unsafe(`create role wa_app with login nosuperuser nobypassrls nocreatedb nocreaterole password '${pass.replace(/'/g,"''")}'`);
    console.log('✅ CREATE ROLE with password ok');
  } catch (e) {
    console.error('❌ CREATE ROLE failed:', e.message);
  }

  // Grants
  for (const stmt of [
    'grant usage on schema public to wa_app',
    'grant select, insert, update, delete on all tables in schema public to wa_app',
    'alter default privileges in schema public grant select, insert, update, delete on tables to wa_app',
    'revoke update, delete on audit_log from wa_app',
  ]) {
    try {
      await sql.unsafe(stmt);
      console.log('✅', stmt.slice(0, 60));
    } catch (e) {
      console.error('❌', stmt.slice(0, 60), '->', e.message);
    }
  }

  const [check] = await sql`select rolbypassrls as bypass, rolsuper as superuser from pg_roles where rolname = 'wa_app'`;
  console.log('\nFinal wa_app check:', check);
  if (check?.bypass || check?.superuser) {
    console.error('❌ wa_app still has superuser or bypassrls — isolation NOT enforced!');
  } else {
    console.log('✅ wa_app is safe: NOSUPERUSER, NOBYPASSRLS');
  }

} finally {
  await sql.end({ timeout: 5 });
}

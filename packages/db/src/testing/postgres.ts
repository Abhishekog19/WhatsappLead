import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Spins up a throwaway Postgres for verification.
 *
 * Exists because the parts of this system most likely to be wrong are the
 * parts TypeScript cannot check: the hand-written RLS migration, the
 * `for update skip locked` claim, and the jsonb search. A real server is the
 * only thing that can answer whether those work, and the alternative — finding
 * out on the first deploy — is the expensive way.
 *
 * Two connection strings are returned, because that distinction is the whole
 * point. `ownerUrl` is a superuser and is how migrations run. `appUrl` is a
 * plain LOGIN role with no BYPASSRLS, which is the only kind of role the
 * application may use: Postgres exempts superusers from row-level security
 * entirely, so testing isolation over a superuser connection would pass
 * while proving nothing.
 *
 * Dev-only. Nothing in apps/ imports this.
 */

export interface Harness {
  /** Superuser. For migrations and for the system-level worker passes. */
  ownerUrl: string;
  /** Non-superuser, as the web app and worker connect in production. */
  appUrl: string;
  stop: () => Promise<void>;
}

export const APP_ROLE = 'wa_app';
const APP_PASSWORD = 'verify-only';

export async function startPostgres(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'wa-verify-'));
  // A high fixed port rather than a random one, so a leaked process from a
  // previous run is obvious instead of silently colliding.
  const port = 54329;

  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    // initdb's own chatter would bury the test output.
    onLog: () => undefined,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('wa');

  const ownerUrl = `postgres://postgres:postgres@127.0.0.1:${port}/wa`;

  // Mirrors what infra/postgres-init.sh does for a real deployment.
  const admin = postgres(ownerUrl, { max: 1, prepare: false });
  try {
    await admin.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
          create role ${APP_ROLE} login password '${APP_PASSWORD}' nosuperuser nobypassrls;
        else
          alter role ${APP_ROLE} login password '${APP_PASSWORD}' nosuperuser nobypassrls;
        end if;
      end
      $$;
    `);
    await admin.unsafe(`grant connect on database wa to ${APP_ROLE}`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  return {
    ownerUrl,
    appUrl: `postgres://${APP_ROLE}:${APP_PASSWORD}@127.0.0.1:${port}/wa`,
    stop: async () => {
      await pg.stop().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Absolute path to the committed migrations.
 *
 * Exported so verification scripts in other workspaces do not have to guess a
 * relative path to this package's drizzle/ directory.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

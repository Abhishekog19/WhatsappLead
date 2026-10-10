import { createServer } from 'node:net';
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
  // Asked for from the OS rather than hard-coded. Several suites run back to
  // back, and a shut-down Postgres does not release its port instantly — a
  // fixed port made the second suite in a run fail to start, intermittently.
  const port = await freePort();

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

/** A port the OS says is free right now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    // Port 0 asks the kernel to allocate; closing immediately leaves a brief
    // window before Postgres binds it, which is fine for a local test run.
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

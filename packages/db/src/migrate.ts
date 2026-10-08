import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadEnvFile } from '@wa/core';
import { createDb } from './client';

/**
 * Applies pending migrations, then exits.
 *
 * Run as a one-shot container on deploy (`docker compose run --rm migrate`)
 * rather than at web/worker startup, so that two instances booting at once
 * cannot race each other through the same migration.
 */
async function main(): Promise<void> {
  loadEnvFile();

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'DATABASE_URL is not set.\n' +
        'Copy .env.example to .env in the repository root and fill it in.',
    );
    process.exit(1);
  }

  // A single connection: migrations are serial and must not be pooled.
  const { db, sql } = createDb({ url, maxConnections: 1 });

  console.log('Applying migrations...');
  try {
    // fileURLToPath, not URL.pathname — the latter yields "/C:/..." on Windows.
    const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
    await migrate(db, { migrationsFolder });
    console.log('Migrations applied.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

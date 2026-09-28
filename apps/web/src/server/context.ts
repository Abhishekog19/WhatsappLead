import { getDb, type Database, type Sql } from '@wa/db';
import { loadEnv, createLogger, type Logger } from '@wa/core';

/**
 * Server-only singletons.
 *
 * Importing this from a Client Component is a build error — that is deliberate,
 * since it carries the database handle and the decryption key.
 */

let cachedDb: { db: Database; sql: Sql } | null = null;

export function env() {
  return loadEnv();
}

export function database(): Database {
  if (!cachedDb) {
    const e = env();
    cachedDb = getDb(e.DATABASE_URL, {
      // The web tier runs short request-scoped queries; the worker gets its own
      // pool so a long send cannot starve page loads.
      maxConnections: 8,
      debug: e.LOG_LEVEL === 'debug',
    });
  }
  return cachedDb.db;
}

let cachedLogger: Logger | null = null;

export function logger(): Logger {
  if (!cachedLogger) {
    cachedLogger = createLogger({ level: env().LOG_LEVEL, base: { app: 'web' } });
  }
  return cachedLogger;
}

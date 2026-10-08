import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

/**
 * Database client.
 *
 * Two pools, deliberately:
 *   - the web app runs short request-scoped queries and wants a small pool,
 *   - the worker holds long transactions while sending and wants its own.
 * Sharing one pool across both lets a stuck send starve page loads.
 *
 * In development the client is cached on globalThis so Next.js hot reload
 * does not open a new pool on every file save until Postgres refuses
 * connections.
 */

export type Database = ReturnType<typeof createDb>['db'];
export type Sql = ReturnType<typeof postgres>;

export interface DbOptions {
  url: string;
  /** Postgres allows 100 connections by default; leave headroom. */
  maxConnections?: number;
  /** Seconds a connection may sit idle before being closed. */
  idleTimeout?: number;
  debug?: boolean;
}

export function createDb(options: DbOptions) {
  const sql = postgres(options.url, {
    max: options.maxConnections ?? 10,
    idle_timeout: options.idleTimeout ?? 20,
    connect_timeout: 10,
    // Timestamps are read back as Date objects by Drizzle's mode:'date'.
    prepare: false,
    onnotice: options.debug ? console.warn : () => {},
  });

  const db = drizzle(sql, { schema, logger: options.debug ?? false });

  return { db, sql };
}

const globalForDb = globalThis as unknown as {
  __waDb?: { db: Database; sql: Sql };
};

/**
 * Process-wide singleton. Callers that need an isolated pool (tests, one-off
 * scripts) should use {@link createDb} directly and close it themselves.
 */
export function getDb(url: string, options: Omit<DbOptions, 'url'> = {}) {
  if (globalForDb.__waDb) return globalForDb.__waDb;

  const created = createDb({ url, ...options });
  globalForDb.__waDb = created;
  return created;
}

export async function closeDb(): Promise<void> {
  if (!globalForDb.__waDb) return;
  await globalForDb.__waDb.sql.end({ timeout: 5 });
  globalForDb.__waDb = undefined;
}

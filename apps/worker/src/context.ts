import { createLogger, loadEnv, type Env, type Logger } from '@wa/core';
import { createDb, type Database, type Sql } from '@wa/db';

/**
 * Process-wide dependencies, built once at boot.
 *
 * Unlike the web tier there is no per-request lifecycle here, so this is a
 * plain object passed down rather than a set of lazy singletons. The raw `sql`
 * handle is kept so shutdown can drain the pool.
 */
export type WorkerContext = {
  env: Env;
  log: Logger;
  db: Database;
  sql: Sql;
  /** Identifies this process in logs when more than one worker is running. */
  workerId: string;
};

export function createContext(): WorkerContext {
  const env = loadEnv();
  const workerId = `${process.env.HOSTNAME ?? 'worker'}-${process.pid}`;

  const log = createLogger({
    level: env.LOG_LEVEL,
    base: { service: 'worker', workerId },
  });

  // Small pool on purpose: the worker's queries are short, and the Oracle
  // free-tier Postgres is shared with the web app.
  const { db, sql } = createDb({ url: env.DATABASE_URL, maxConnections: 4 });

  return { env, log, db, sql, workerId };
}

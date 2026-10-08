import {
  createLogger,
  loadEnv,
  loadEnvFile,
  type Env,
  type Logger,
} from '@wa/core';
import { createDb, type Database, type Sql } from '@wa/db';
import { WaManager } from '@wa/wa';

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
  /** Every live WhatsApp socket. Only this process may hold one. */
  wa: WaManager;
  /** Identifies this process in logs when more than one worker is running. */
  workerId: string;
};

export function createContext(): WorkerContext {
  // Before loadEnv, so a terminal-launched worker sees the root .env. A no-op
  // in the container, where Compose has already supplied the environment.
  loadEnvFile();

  const env = loadEnv();
  const workerId = `${process.env.HOSTNAME ?? 'worker'}-${process.pid}`;

  const log = createLogger({
    level: env.LOG_LEVEL,
    base: { service: 'worker', workerId },
  });

  // Small pool on purpose: the worker's queries are short, and the Oracle
  // free-tier Postgres is shared with the web app.
  const { db, sql } = createDb({ url: env.DATABASE_URL, maxConnections: 4 });

  const wa = new WaManager(db, env.CREDS_ENCRYPTION_KEY, log, env.LOG_LEVEL);

  return { env, log, db, sql, wa, workerId };
}

import { randomUUID } from 'node:crypto';
import {
  createLogger,
  loadEnv,
  loadEnvFile,
  type Env,
  type Logger,
} from '@wa/core';
import { createDb, renewOwnedSession, type Database, type Sql } from '@wa/db';
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
  // Host and pid alone are not unique enough now that session ownership is
  // keyed on this. Two instances during a deployment overlap can easily show
  // the same hostname, and a recycled container can reuse a pid — and two
  // processes sharing a worker id would each believe they hold the other's
  // lease, which is precisely the double-socket this is meant to prevent.
  const workerId = `${process.env.HOSTNAME ?? 'worker'}-${process.pid}-${randomUUID().slice(0, 8)}`;

  const log = createLogger({
    level: env.LOG_LEVEL,
    base: { service: 'worker', workerId },
  });

  // Small and configurable. This process shares a 512 MB container with the
  // website, and both share a connection pooler with its own client limit —
  // so the pool size is a budget, not an optimisation.
  const { db, sql } = createDb({
    url: env.DATABASE_URL,
    maxConnections: env.WORKER_DB_POOL,
  });

  const wa = new WaManager(db, env.CREDS_ENCRYPTION_KEY, log, 'silent', async (sessionId) => {
    if (!await renewOwnedSession(db, sessionId, workerId)) {
      throw new Error('Session ownership or account permission expired');
    }
  });

  return { env, log, db, sql, wa, workerId };
}

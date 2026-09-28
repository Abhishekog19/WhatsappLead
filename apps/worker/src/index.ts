import { sql } from '@wa/db';
import { createContext } from './context';
import { startHealthServer } from './health';
import { Scheduler } from './scheduler';
import { expirePairingArtifacts } from './jobs/expire-pairing-artifacts';
import { reapStaleClaims } from './jobs/reap-stale-claims';
import { settleCampaigns } from './jobs/settle-campaigns';

/**
 * The background worker.
 *
 * Everything that must keep happening while nobody has a browser tab open runs
 * here: sending, reconnecting WhatsApp sockets, enforcing the rolling
 * 24-hour caps, and the housekeeping below. The web app never sends a message
 * itself — a request lasts seconds, a campaign lasts hours.
 *
 * As of phase 0 the jobs are the housekeeping ones. The send loop and the
 * WhatsApp connection manager attach to the same scheduler in phase 3.
 *
 * Shutdown matters more than usual here. A `docker compose up -d --build`
 * sends SIGTERM, and a worker killed mid-send leaves a target row claimed. The
 * handler below stops scheduling, lets the job in flight finish, and only then
 * drains the connection pool.
 */

/** Longest we wait for in-flight work before exiting anyway. */
const SHUTDOWN_GRACE_MS = 20_000;

async function main(): Promise<void> {
  const ctx = createContext();

  ctx.log.info('worker booting', {
    nodeEnv: ctx.env.NODE_ENV,
    engine: ctx.env.WA_ENGINE,
    tickMs: ctx.env.WORKER_TICK_MS,
  });

  // Fail fast on a bad DATABASE_URL rather than letting every job log the same
  // connection error once a minute.
  await ctx.db.execute(sql`select 1`);
  ctx.log.info('database reachable');

  const scheduler = new Scheduler(ctx, [
    reapStaleClaims,
    settleCampaigns,
    expirePairingArtifacts,
  ]);
  const health = startHealthServer(ctx, scheduler);

  scheduler.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      ctx.log.warn('second signal during shutdown, exiting now', { signal });
      process.exit(1);
    }
    shuttingDown = true;
    ctx.log.info('shutting down', { signal });

    // Stop answering health checks first so the orchestrator routes elsewhere
    // while the current job finishes.
    health.close();
    await scheduler.stop(SHUTDOWN_GRACE_MS);
    await ctx.sql.end({ timeout: 5 });

    ctx.log.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection means a promise escaped the scheduler's try/catch.
  // Log it loudly and keep running: dropping every campaign because one stray
  // promise rejected is the worse outcome.
  process.on('unhandledRejection', (reason) => {
    ctx.log.error('unhandled rejection', { error: reason });
  });
  process.on('uncaughtException', (error) => {
    // An uncaught exception leaves the process in an unknown state. Exit and
    // let the restart policy give us a clean one.
    ctx.log.error('uncaught exception, exiting', { error });
    process.exit(1);
  });
}

main().catch((error) => {
  // No logger yet if createContext() threw — env validation failures land here.
  console.error('[worker] failed to start:', error);
  process.exit(1);
});

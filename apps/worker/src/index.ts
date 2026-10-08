import { assertTenantIsolation, sql } from '@wa/db';
import { createContext } from './context';
import { startHealthServer } from './health';
import { Scheduler } from './scheduler';
import { expirePairingArtifacts } from './jobs/expire-pairing-artifacts';
import { maintainSessions } from './jobs/maintain-sessions';
import { reapStaleClaims } from './jobs/reap-stale-claims';
import { sendCampaigns } from './jobs/send-campaigns';
import { settleCampaigns } from './jobs/settle-campaigns';

/**
 * The background worker.
 *
 * Everything that must keep happening while nobody has a browser tab open runs
 * here: sending, reconnecting WhatsApp sockets, enforcing the rolling
 * 24-hour caps, and the housekeeping below. The web app never sends a message
 * itself — a request lasts seconds, a campaign lasts hours.
 *
 * This is also the only process allowed to hold a WhatsApp socket. WhatsApp
 * permits one connection per linked device, so a second one opened by the web
 * tier would fight this one until the number got logged out.
 *
 * Shutdown matters more than usual here. A `docker compose up -d --build`
 * sends SIGTERM, and a worker killed mid-send leaves a target row claimed. The
 * handler below stops scheduling, lets the job in flight finish, closes every
 * socket so the credential writes land, and only then drains the pool.
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

  // Refuse to run if tenant isolation is not actually enforced. A superuser
  // connection makes every row-level security policy a no-op without any
  // visible symptom, so this is checked rather than assumed — the whole
  // product rests on one account's data never touching another's.
  const isolation = await assertTenantIsolation(ctx.db);
  ctx.log.info('tenant isolation enforced', { role: isolation.role });

  const scheduler = new Scheduler(ctx, [
    // Order is deliberate: sockets are brought up before the sender looks for
    // work, so a freshly resumed session is usable on the same tick.
    maintainSessions,
    sendCampaigns,
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
    // Before the pool closes: each socket flushes its encrypted auth state,
    // and that write needs a connection.
    await ctx.wa.closeAll();
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

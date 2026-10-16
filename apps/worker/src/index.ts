import { checkTenantIsolation, releaseAllLeases, renewOwnedSession, sql } from '@wa/db';
import { createContext } from './context';
import { startHealthServer } from './health';
import { Scheduler } from './scheduler';
import { expirePairingArtifacts } from './jobs/expire-pairing-artifacts';
import { heartbeat } from './jobs/heartbeat';
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
  // Fail startup on a partially migrated deployment, before opening sockets.
  await ctx.db.execute(sql`select next_send_at, batch_sent_count from campaigns limit 0`);
  await ctx.db.execute(sql`select dispatch_started_at from campaign_targets limit 0`);
  await ctx.db.execute(sql`select session_id from wa_session_leases limit 0`);
  ctx.log.info('database reachable');

  // Refuse to run if tenant isolation is not actually enforced. A superuser
  // connection makes every row-level security policy a no-op without any
  // visible symptom, so this is checked rather than assumed — the whole
  // product rests on one account's data never touching another's.
  //
  // Development is allowed to continue, because a local `postgres` superuser
  // or a provider's default role is the normal starting point and refusing to
  // boot would just teach people to delete this check. It still runs, and
  // still says exactly what is wrong — the finding is too easy to lose.
  const isolation = await checkTenantIsolation(ctx.db);
  if (isolation.ok) {
    ctx.log.info('tenant isolation enforced', { role: isolation.role });
  } else if (ctx.env.NODE_ENV === 'production') {
    throw new Error(
      `Tenant isolation is not enforced.\n\n${isolation.problems
        .map((p) => `  - ${p}`)
        .join('\n')}\n\nSee packages/db/drizzle/0001_rls.sql.`,
    );
  } else {
    ctx.log.warn(
      'TENANT ISOLATION IS NOT ENFORCED — one account can read another\'s data. ' +
        'Fine for a single-user local database; this would refuse to boot in production.',
      { role: isolation.role, problems: isolation.problems },
    );
  }

  const scheduler = new Scheduler(ctx, [
    // First, so the web app learns this process exists before anything slow
    // runs — otherwise a freshly started worker looks dead for a tick or two.
    heartbeat,
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

  // Renew independently of the serial scheduler: a slow send must not starve
  // session ownership. Fail closed on DB loss or an expired lease.
  let renewing = false;
  const leaseTimer = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      for (const id of Object.keys(ctx.wa.statuses())) {
        let timer: NodeJS.Timeout | undefined;
        const held = await Promise.race([
          renewOwnedSession(ctx.db, id, ctx.workerId),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 10_000); }),
        ]).catch(() => false).finally(() => { if (timer) clearTimeout(timer); });
        if (!held) await ctx.wa.drop(id);
      }
    } catch {
      ctx.log.error('session ownership guard failed; restarting worker');
      process.exit(1);
    } finally { renewing = false; }
  }, 20_000);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      ctx.log.warn('second signal during shutdown, exiting now', { signal });
      process.exit(1);
    }
    shuttingDown = true;
    clearInterval(leaseTimer);
    ctx.log.info('shutting down', { signal });

    // Stop answering health checks first so the orchestrator routes elsewhere
    // while the current job finishes.
    health.close();
    await scheduler.stop(SHUTDOWN_GRACE_MS);
    // Before the pool closes: each socket flushes its encrypted auth state,
    // and that write needs a connection.
    await ctx.wa.closeAll();

    // Hand the session leases back explicitly. They would lapse on their own
    // within 90 seconds, but a deployment starts the replacement immediately —
    // releasing here is the difference between the new instance picking the
    // sessions up at once and every account sitting idle while the old lease
    // times out.
    const released = await releaseAllLeases(ctx.db, ctx.workerId).catch((err) => {
      ctx.log.warn('could not release session leases on shutdown', { error: err });
      return 0;
    });
    if (released > 0) ctx.log.info('released session leases', { count: released });
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

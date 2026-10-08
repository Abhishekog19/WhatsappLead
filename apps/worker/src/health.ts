import { createServer, type Server } from 'node:http';
import { sql } from '@wa/db';
import type { WorkerContext } from './context';
import type { Scheduler } from './scheduler';

/**
 * A tiny HTTP surface so the container orchestrator can tell a wedged worker
 * from a busy one.
 *
 * Bound to all interfaces but never published outside the Docker network — the
 * reverse proxy only knows about the web service. Nothing here is
 * authenticated, so the payload is limited to counters: no user ids, no phone
 * numbers, no campaign names.
 */

/** A worker whose loop has not ticked in this long is considered stuck. */
const STUCK_AFTER_MS = 120_000;

export function startHealthServer(ctx: WorkerContext, scheduler: Scheduler): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/health' || url === '/') {
      void respond(ctx, scheduler, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });

  server.listen(ctx.env.WORKER_HEALTH_PORT, () => {
    ctx.log.info('health server listening', { port: ctx.env.WORKER_HEALTH_PORT });
  });

  return server;
}

async function respond(
  ctx: WorkerContext,
  scheduler: Scheduler,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const status = scheduler.status();
  const sinceTick = status.lastTickAt === null ? null : Date.now() - status.lastTickAt;
  const stuck = sinceTick !== null && sinceTick > STUCK_AFTER_MS;

  let db = 'ok';
  try {
    await ctx.db.execute(sql`select 1`);
  } catch {
    db = 'unreachable';
  }

  const healthy = db === 'ok' && !stuck && !status.stopping;
  const body = JSON.stringify({
    status: healthy ? 'ok' : 'degraded',
    db,
    workerId: ctx.workerId,
    uptimeMs: Date.now() - status.startedAt,
    ticks: status.ticks,
    msSinceLastTick: sinceTick,
    stopping: status.stopping,
    jobs: status.jobs,
  });

  res.writeHead(healthy ? 200 : 503, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

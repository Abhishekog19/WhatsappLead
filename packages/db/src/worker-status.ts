import { sql } from 'drizzle-orm';
import type { Database } from './client';
import type { Tx } from './tenant';

/**
 * Is a worker running?
 *
 * The question matters because the web app cannot otherwise tell a campaign
 * that is pacing itself from one whose sender is dead — both are status
 * 'running' with queued targets and no movement. Telling a user "sending,
 * roughly one message a minute" when nothing is running is worse than
 * admitting ignorance.
 */

/**
 * Six missed beats.
 *
 * The heartbeat job runs every ten seconds, and a worker mid-way through a
 * slow job legitimately skips a few. A minute is long enough not to cry wolf
 * during a long send, and short enough that someone who forgot to start the
 * worker finds out while they are still looking at the screen.
 */
export const WORKER_STALE_AFTER_MS = 60_000;

export interface WorkerStatus {
  /** A worker has checked in recently enough to be trusted. */
  alive: boolean;
  /** Null when no worker has ever checked in. */
  lastSeenAt: Date | null;
  /** How many processes are currently considered alive. */
  liveWorkers: number;
  /** Total WhatsApp sockets held across them. */
  openSessions: number;
}

export async function workerStatus(db: Database | Tx): Promise<WorkerStatus> {
  const rows = await db.execute<{
    last_seen: string | null;
    live: number;
    sockets: number;
  }>(sql`
    select max(last_seen_at)                                              as last_seen,
           count(*) filter (
             where last_seen_at > now() - ${`${WORKER_STALE_AFTER_MS} milliseconds`}::interval
           )::int                                                         as live,
           coalesce(sum(open_sessions) filter (
             where last_seen_at > now() - ${`${WORKER_STALE_AFTER_MS} milliseconds`}::interval
           ), 0)::int                                                     as sockets
      from worker_heartbeats
  `);

  const row = rows[0];
  const lastSeenAt = row?.last_seen ? new Date(row.last_seen) : null;
  const liveWorkers = Number(row?.live ?? 0);

  return {
    alive: liveWorkers > 0,
    lastSeenAt,
    liveWorkers,
    openSessions: Number(row?.sockets ?? 0),
  };
}

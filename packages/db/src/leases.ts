import { and, eq, lt, sql } from 'drizzle-orm';
import type { Database } from './client';
import { asSystem } from './tenant';
import { waSessionLeases } from './schema/accounts';

/**
 * Ownership of a WhatsApp session, as a database-backed lease.
 *
 * WhatsApp allows one connection per linked device. Two workers holding the
 * same session fight over it, and WhatsApp settles the argument by logging the
 * number out — which costs the user a re-pair and every queued message. This
 * is not a theoretical race: a deployment starts the replacement before the
 * old instance has finished shutting down, and a host that recycles instances
 * freely makes the overlap routine.
 *
 * WHY NOT ADVISORY LOCKS. `pg_advisory_lock` is session-scoped, and a
 * connection pooler in transaction mode gives each transaction whichever
 * backend is free — so the lock would be taken on one connection and the next
 * query would run on another that does not hold it. `pg_advisory_xact_lock`
 * is honest about its scope but releases at commit, which cannot express
 * ownership held for hours. Neither survives the pooler this deployment has
 * to use, because the provider's direct connections are IPv6-only.
 *
 * A row with an expiry needs no session state at all. Acquisition is ONE
 * statement — an upsert whose DO UPDATE is conditional — so two workers
 * racing cannot both win regardless of how the pooler routes them.
 */

/**
 * How long a lease is good for.
 *
 * Long enough to survive a slow reconciliation pass or a paused container;
 * short enough that a worker killed without cleanup does not strand a session
 * for long. The holder renews on every pass, so in practice a lease is only
 * ever seconds old.
 */
export const LEASE_TTL_MS = 90_000;

/** Renewal never reacquires an expired lease. Used immediately before I/O. */
export async function renewOwnedSession(db: Database, sessionId: string, workerId: string): Promise<boolean> {
  return asSystem(db, async (tx) => {
    const rows = await tx.execute(sql`
      update wa_session_leases l set expires_at = now() + interval '90 seconds'
      from wa_sessions s
      where l.session_id = ${sessionId} and l.worker_id = ${workerId}
        and l.expires_at > now() and s.id = l.session_id
        and s.deleted_at is null
        and s.status in ('pending', 'pairing', 'connected', 'disconnected')
        and (s.throttled_until is null or s.throttled_until <= now())
      returning l.session_id
    `);
    return rows.length === 1;
  });
}

export interface LeaseResult {
  /** True when the calling worker may open or keep the socket. */
  held: boolean;
  /** Who holds it. Null only if the row vanished between statements. */
  heldBy: string | null;
}

/**
 * Takes or renews the lease on a session.
 *
 * Succeeds when the lease is unheld, already ours, or expired. Fails — without
 * error — when another worker holds a live one, which is the normal answer
 * during a deployment overlap and not something to log loudly.
 */
export async function acquireSessionLease(
  db: Database,
  sessionId: string,
  workerId: string,
  ttlMs: number = LEASE_TTL_MS,
): Promise<LeaseResult> {
  return asSystem(db, async (tx) => {
    // One statement, so there is no window between checking and taking. The
    // WHERE on DO UPDATE is what makes it safe: a conflicting row is only
    // overwritten if it is already ours or has expired, and otherwise the
    // statement returns nothing at all.
    const rows = await tx.execute<{ worker_id: string }>(sql`
      insert into wa_session_leases (session_id, worker_id, acquired_at, expires_at)
      values (
        ${sessionId},
        ${workerId},
        now(),
        now() + ${`${ttlMs} milliseconds`}::interval
      )
      on conflict (session_id) do update
         set worker_id  = excluded.worker_id,
             expires_at = excluded.expires_at,
             -- Only moved when ownership actually changes hands, so the column
             -- stays a record of when this worker took over rather than when
             -- it last renewed.
             acquired_at = case
               when wa_session_leases.worker_id = excluded.worker_id
                 then wa_session_leases.acquired_at
               else now()
             end
       where wa_session_leases.worker_id = excluded.worker_id
          or wa_session_leases.expires_at <= now()
      returning worker_id
    `);

    const winner = rows[0]?.worker_id ?? null;
    if (winner === workerId) return { held: true, heldBy: workerId };

    // Nothing came back: the conditional update declined, so someone else has
    // a live lease. Read it so the caller can say who, for the logs.
    const current = await tx
      .select({ workerId: waSessionLeases.workerId })
      .from(waSessionLeases)
      .where(eq(waSessionLeases.sessionId, sessionId))
      .limit(1);

    return { held: false, heldBy: current[0]?.workerId ?? null };
  });
}

/**
 * Gives up a lease.
 *
 * Scoped to this worker, so a late shutdown cannot release a lease another
 * worker has since taken over — which would hand two processes the same
 * session, the exact thing this exists to prevent.
 */
export async function releaseSessionLease(
  db: Database,
  sessionId: string,
  workerId: string,
): Promise<void> {
  await asSystem(db, async (tx) => {
    await tx
      .delete(waSessionLeases)
      .where(
        and(
          eq(waSessionLeases.sessionId, sessionId),
          eq(waSessionLeases.workerId, workerId),
        ),
      );
  });
}

/** Releases every lease this worker holds. For shutdown. */
export async function releaseAllLeases(
  db: Database,
  workerId: string,
): Promise<number> {
  return asSystem(db, async (tx) => {
    const rows = await tx
      .delete(waSessionLeases)
      .where(eq(waSessionLeases.workerId, workerId))
      .returning({ sessionId: waSessionLeases.sessionId });
    return rows.length;
  });
}

/**
 * Clears leases that have lapsed.
 *
 * Not strictly required — acquisition already treats an expired lease as
 * free — but it keeps the table from accumulating rows for sessions nothing
 * will claim again, and makes "who owns what" readable when something is
 * wrong.
 */
export async function pruneExpiredLeases(db: Database): Promise<number> {
  return asSystem(db, async (tx) => {
    const rows = await tx
      .delete(waSessionLeases)
      .where(lt(waSessionLeases.expiresAt, new Date(Date.now() - LEASE_TTL_MS)))
      .returning({ sessionId: waSessionLeases.sessionId });
    return rows.length;
  });
}

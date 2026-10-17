import { checkTenantIsolation, sql, workerStatus } from '@wa/db';
import { database, logger } from '@/server/context';

/** Render readiness: database isolation and this instance worker, bounded to four seconds. */

export const dynamic = 'force-dynamic';

/** Long enough for a cross-region round trip, short enough to still be an answer. */
const CHECK_TIMEOUT_MS = 4_000;

type CheckState = 'ok' | 'failed' | 'timeout';

async function bounded<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ state: CheckState; value?: T }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
    return { state: 'ok', value };
  } catch (error) {
    return { state: error instanceof Error && error.message === 'timeout' ? 'timeout' : 'failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let inFlight: Promise<Response> | null = null;
let recent: { response: Response; until: number } | null = null;

export async function GET(): Promise<Response> {
  if (recent && Date.now() < recent.until) return recent.response.clone();
  // Coalesce concurrent probes rather than consuming the entire DB pool.
  if (!inFlight) inFlight = check().then(response => {
    recent = { response: response.clone(), until: Date.now() + 15_000 };
    return response;
  }).finally(() => { inFlight = null; });
  return (await inFlight).clone();
}

async function check(): Promise<Response> {
  const started = Date.now();
  const db = database();

  const [connectivity, isolation, worker] = await Promise.all([
    bounded(db.execute(sql`select 1`), CHECK_TIMEOUT_MS),
    bounded(checkTenantIsolation(db), CHECK_TIMEOUT_MS),
    bounded(process.env.WORKER_HEALTH_HOST === '127.0.0.1'
      ? fetch(`http://127.0.0.1:${process.env.WORKER_HEALTH_PORT ?? '3001'}/health`, {
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), cache: 'no-store',
        }).then(async (r) => ({ alive: r.ok && (await r.json()).status === 'ok', openSessions: 0 }))
      : workerStatus(db), CHECK_TIMEOUT_MS),
  ]);

  const dbState = connectivity.state;
  const isolationEnforced = isolation.state === 'ok' && isolation.value?.ok === true;
  const workerAlive = worker.state === 'ok' && worker.value?.alive === true;

  const ready = dbState === 'ok' && isolationEnforced && workerAlive;

  if (!ready) {
    // Detail goes to the log, not the response: this endpoint is
    // unauthenticated, and "which tenant policy is missing" is not something
    // to publish.
    logger().warn('readiness check failed', {
      db: dbState,
      isolation: isolation.state === 'ok' ? isolation.value?.problems : isolation.state,
      worker: worker.state === 'ok' ? { alive: worker.value?.alive } : worker.state,
    });
  }

  return Response.json(
    {
      status: ready ? 'ok' : 'degraded',
      db: dbState,
      // Enforced or not — never which policy, nor which role.
      isolation: isolationEnforced ? 'enforced' : 'not_enforced',
      worker: workerAlive ? 'alive' : 'down',
      // Counters only; no ids, numbers or names.
      openSessions: worker.state === 'ok' ? (worker.value?.openSessions ?? 0) : null,
      latencyMs: Date.now() - started,
    },
    {
      status: ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

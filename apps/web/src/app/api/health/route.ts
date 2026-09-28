import { sql } from '@wa/db';
import { database } from '@/server/context';

/**
 * Liveness + readiness in one endpoint, for the reverse proxy and for the
 * deploy script to poll before switching traffic over.
 *
 * Returns 503 rather than 200-with-an-error-body so a health check does not
 * have to parse JSON to know something is wrong.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const started = Date.now();
  try {
    await database().execute(sql`select 1`);
    return Response.json(
      { status: 'ok', db: 'ok', latencyMs: Date.now() - started },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    // Deliberately no error detail — this endpoint is unauthenticated.
    return Response.json(
      { status: 'degraded', db: 'unreachable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

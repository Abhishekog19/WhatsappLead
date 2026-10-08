import { checkTenantIsolation, sql } from '@wa/db';
import { database, logger } from '@/server/context';

/**
 * Liveness + readiness in one endpoint, for the reverse proxy and for the
 * deploy script to poll before switching traffic over.
 *
 * Returns 503 rather than 200-with-an-error-body so a health check does not
 * have to parse JSON to know something is wrong.
 *
 * Tenant isolation is part of readiness, not a nice-to-have. If the database
 * role turns out to be a superuser, row-level security is silently inert and
 * the app is one missing `where` clause away from serving another account's
 * contacts — so it reports unhealthy and the deploy fails rather than
 * quietly going live.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const started = Date.now();
  try {
    const db = database();
    await db.execute(sql`select 1`);

    const isolation = await checkTenantIsolation(db);
    if (!isolation.ok) {
      // Logged in full server-side; the response stays vague because this
      // endpoint is unauthenticated.
      logger().error('tenant isolation is not enforced', {
        role: isolation.role,
        problems: isolation.problems,
      });
      return Response.json(
        { status: 'degraded', db: 'ok', isolation: 'not_enforced' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return Response.json(
      {
        status: 'ok',
        db: 'ok',
        isolation: 'enforced',
        latencyMs: Date.now() - started,
      },
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

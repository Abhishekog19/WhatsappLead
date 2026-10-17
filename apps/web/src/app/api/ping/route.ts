/** External monitor liveness: no database, configuration, or tenant data. */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response('ok', {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** Monitors that prefer a HEAD request get the same answer, with no body. */
export function HEAD(): Response {
  return new Response(null, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}

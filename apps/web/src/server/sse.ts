/**
 * Shared limits for the Server-Sent Event routes.
 *
 * The ceiling is a hosting constraint, not a product one. Serverless platforms
 * kill a response that runs too long: Vercel's Hobby plan terminates a
 * function at 300 seconds and returns a 504, which the browser sees as a
 * broken stream rather than a finished one.
 *
 * So the streams close themselves first, well inside that. EventSource
 * reconnects on its own, so a four-minute cap costs one reconnect and a
 * negligible gap; being cut off mid-response costs an error the UI has to
 * explain. On a long-lived host — the Docker deployment, where Caddy is
 * configured for 30-minute reads — this simply means a tidy reconnect that
 * nobody notices.
 */
export const SSE_MAX_DURATION_MS = 240_000;

/**
 * Comment frames, to stop an intermediary treating an idle stream as dead.
 * Ignored by EventSource.
 */
export const SSE_HEARTBEAT_MS = 20_000;

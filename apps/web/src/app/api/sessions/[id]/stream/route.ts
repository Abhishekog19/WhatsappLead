import { and, eq, isNull, waSessions } from '@wa/db';
import { queryAsUser } from '@/server/session';

/**
 * Live session status, as Server-Sent Events.
 *
 * The pairing code arrives asynchronously: the browser writes a row, the
 * worker performs the handshake a second or two later, and WhatsApp returns a
 * code with a short life. Polling would either feel slow or hammer the
 * database; one long-lived response that pushes on change is both cheaper and
 * instant.
 *
 * Caddy and next.config.ts both carve out `/api/*&#47;stream` from response
 * buffering, which is what makes the pushes actually arrive rather than
 * sitting in a proxy until the stream closes.
 */

const POLL_MS = 1_500;
/** Pairing cannot take this long; a hung tab must not hold a connection open. */
const MAX_DURATION_MS = 10 * 60 * 1_000;
const HEARTBEAT_MS = 20_000;

export const dynamic = 'force-dynamic';

interface Snapshot {
  status: string;
  phoneE164: string | null;
  pairingCode: string | null;
  pairingCodeExpiresAt: string | null;
  qrPayload: string | null;
  lastError: string | null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  // Authorise once, up front. queryAsUser redirects a guest, and row-level
  // security means another user's id simply returns nothing.
  const initial = await read(id);
  if (!initial) {
    return new Response('Not found', { status: 404 });
  }

  const encoder = new TextEncoder();
  let timer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let deadline: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastSerialised = '';

      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // The client went away between the check and the write.
          closed = true;
        }
      };

      const finish = (): void => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        if (heartbeat) clearInterval(heartbeat);
        if (deadline) clearTimeout(deadline);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      lastSerialised = JSON.stringify(initial);
      send('status', initial);

      timer = setInterval(() => {
        void (async () => {
          const snapshot = await read(id).catch(() => null);
          if (!snapshot) return finish();

          const serialised = JSON.stringify(snapshot);
          if (serialised === lastSerialised) return;
          lastSerialised = serialised;
          send('status', snapshot);

          // Terminal states: nothing further will change without the user
          // acting, so release the connection.
          if (
            snapshot.status === 'connected' ||
            snapshot.status === 'banned' ||
            snapshot.status === 'logged_out'
          ) {
            finish();
          }
        })();
      }, POLL_MS);

      // Comment frames keep intermediaries from treating the idle stream as
      // dead. They are ignored by EventSource.
      heartbeat = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            finish();
          }
        }
      }, HEARTBEAT_MS);

      deadline = setTimeout(finish, MAX_DURATION_MS);
    },

    cancel() {
      if (timer) clearInterval(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (deadline) clearTimeout(deadline);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

async function read(sessionId: string): Promise<Snapshot | null> {
  return queryAsUser(async (tx, userId) => {
    const rows = await tx
      .select({
        status: waSessions.status,
        phoneE164: waSessions.phoneE164,
        pairingCode: waSessions.pairingCode,
        pairingCodeExpiresAt: waSessions.pairingCodeExpiresAt,
        qrPayload: waSessions.qrPayload,
        lastError: waSessions.lastError,
      })
      .from(waSessions)
      .where(
        and(
          eq(waSessions.id, sessionId),
          eq(waSessions.userId, userId),
          isNull(waSessions.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      status: row.status,
      phoneE164: row.phoneE164,
      pairingCode: row.pairingCode,
      pairingCodeExpiresAt: row.pairingCodeExpiresAt?.toISOString() ?? null,
      qrPayload: row.qrPayload,
      lastError: row.lastError,
    };
  });
}

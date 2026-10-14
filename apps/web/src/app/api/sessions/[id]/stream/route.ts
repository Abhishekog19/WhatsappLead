import QRCode from 'qrcode';
import { and, eq, isNull, waSessions } from '@wa/db';
import { queryAsUser } from '@/server/session';
import { SSE_HEARTBEAT_MS, SSE_MAX_DURATION_MS } from '@/server/sse';

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

export const dynamic = 'force-dynamic';

interface Snapshot {
  status: string;
  phoneE164: string | null;
  linkMethod: 'pairing_code' | 'qr';
  pairingCode: string | null;
  pairingCodeExpiresAt: string | null;
  /**
   * The QR as a PNG data URL, not the raw payload.
   *
   * Rendered here rather than in the browser so the client needs no QR
   * library, and because the payload is a WhatsApp linking token — there is
   * no reason for it to exist anywhere except inside an <img>.
   */
  qrImage: string | null;
  qrExpiresAt: string | null;
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
      }, SSE_HEARTBEAT_MS);

      deadline = setTimeout(finish, SSE_MAX_DURATION_MS);
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
        linkMethod: waSessions.linkMethod,
        pairingCode: waSessions.pairingCode,
        pairingCodeExpiresAt: waSessions.pairingCodeExpiresAt,
        qrPayload: waSessions.qrPayload,
        qrExpiresAt: waSessions.qrExpiresAt,
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
      linkMethod: row.linkMethod,
      pairingCode: row.pairingCode,
      pairingCodeExpiresAt: row.pairingCodeExpiresAt?.toISOString() ?? null,
      qrImage: row.qrPayload ? await renderQr(row.qrPayload) : null,
      qrExpiresAt: row.qrExpiresAt?.toISOString() ?? null,
      lastError: row.lastError,
    };
  });
}

/**
 * The QR WhatsApp wants scanned, as a PNG data URL.
 *
 * Margin 1 rather than the default 4: on a phone the surrounding whitespace
 * is wasted width, and WhatsApp's scanner copes fine with a tight quiet zone.
 * Error correction stays at the library default — a QR that fails to scan is
 * worse than a slightly denser one.
 */
async function renderQr(payload: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(payload, { margin: 1, width: 320 });
  } catch {
    // A malformed payload should not take the whole status stream down; the
    // UI falls back to telling the user to request a new code.
    return null;
  }
}

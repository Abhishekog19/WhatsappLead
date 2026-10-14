import { and, campaigns, campaignTargets, contacts, eq, sql } from '@wa/db';
import { queryAsUser } from '@/server/session';

/**
 * Live campaign progress, as Server-Sent Events.
 *
 * A campaign sends one message every 25–55 seconds, with much longer pauses
 * between batches, so the interesting question is not "what is the number
 * right now" but "is it still moving". A page that only reloads on a timer
 * cannot answer that: the counters jump, and in between there is no way to
 * tell progress from a stall.
 *
 * So this pushes a snapshot whenever something actually changes, and says
 * nothing when nothing does — which is itself the signal that the campaign is
 * between messages rather than stuck.
 *
 * Polling here rather than listening to Postgres: the worker is a separate
 * process, so NOTIFY would be the alternative, and a two-second SELECT on an
 * indexed primary key is far less machinery for the same result at this scale.
 */

const POLL_MS = 2_000;
const HEARTBEAT_MS = 20_000;
/** A left-open tab must not hold a connection for the whole campaign. */
const MAX_DURATION_MS = 30 * 60 * 1_000;

export const dynamic = 'force-dynamic';

interface Snapshot {
  status: string;
  totalTargets: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  replyCount: number;
  pauseReason: string | null;
  /** The most recent send, so the feed shows movement and not just totals. */
  latest: { name: string | null; phoneE164: string; sentAt: string } | null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const initial = await read(id);
  if (!initial) return new Response('Not found', { status: 404 });

  const encoder = new TextEncoder();
  let poll: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let deadline: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let last = '';

      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      const finish = (): void => {
        if (closed) return;
        closed = true;
        if (poll) clearInterval(poll);
        if (heartbeat) clearInterval(heartbeat);
        if (deadline) clearTimeout(deadline);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      last = JSON.stringify(initial);
      send('progress', initial);

      poll = setInterval(() => {
        void (async () => {
          const snapshot = await read(id).catch(() => null);
          if (!snapshot) return finish();

          const serialised = JSON.stringify(snapshot);
          if (serialised === last) return;
          last = serialised;
          send('progress', snapshot);

          // Nothing further will change on its own once it has finished.
          if (
            snapshot.status === 'completed' ||
            snapshot.status === 'cancelled' ||
            snapshot.status === 'failed'
          ) {
            finish();
          }
        })();
      }, POLL_MS);

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          finish();
        }
      }, HEARTBEAT_MS);

      deadline = setTimeout(finish, MAX_DURATION_MS);
    },

    cancel() {
      if (poll) clearInterval(poll);
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

async function read(campaignId: string): Promise<Snapshot | null> {
  return queryAsUser(async (tx, userId) => {
    const rows = await tx
      .select({
        status: campaigns.status,
        totalTargets: campaigns.totalTargets,
        sentCount: campaigns.sentCount,
        failedCount: campaigns.failedCount,
        skippedCount: campaigns.skippedCount,
        replyCount: campaigns.replyCount,
        pauseReason: campaigns.pauseReason,
      })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const latest = await tx
      .select({
        name: contacts.name,
        phoneE164: contacts.phoneE164,
        sentAt: campaignTargets.sentAt,
      })
      .from(campaignTargets)
      .innerJoin(contacts, eq(contacts.id, campaignTargets.contactId))
      .where(
        and(
          eq(campaignTargets.campaignId, campaignId),
          eq(campaignTargets.status, 'sent'),
        ),
      )
      // Written as one fragment, not desc(sql`… nulls last`): wrapping it
      // produces "order by sent_at nulls last desc", which Postgres rejects.
      // The stream's first read then threw, the route 500'd, and the page sat
      // on "reconnecting" with no clue why.
      .orderBy(sql`${campaignTargets.sentAt} desc nulls last`)
      .limit(1);

    const top = latest[0];

    return {
      ...row,
      latest:
        top && top.sentAt
          ? {
              name: top.name,
              phoneE164: top.phoneE164,
              sentAt: top.sentAt.toISOString(),
            }
          : null,
    };
  });
}

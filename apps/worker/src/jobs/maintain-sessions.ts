import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { asSystem, schema } from '@wa/db';
import type { Job } from '../scheduler';

/**
 * Keeps the set of live WhatsApp sockets in step with the database.
 *
 * The web tier cannot open a socket — it may be running in several processes,
 * and WhatsApp allows one connection per linked device. So linking is a
 * request written to a row, and this job is what notices it. The browser then
 * polls the same row for the pairing code. The database is the message bus;
 * there is no RPC between the two tiers.
 */
export const maintainSessions: Job = {
  name: 'maintain-sessions',
  everyMs: 5_000,

  async run(ctx) {
    const summary = { linked: 0, resumed: 0, released: 0, dropped: 0 };

    // --- 1. Throttle holds that have expired ------------------------------
    // Back to 'disconnected' rather than 'connected': the hold is over, but
    // nothing has reconnected yet, and claiming otherwise would let a
    // campaign start sending before a socket exists.
    const released = await asSystem(ctx.db, async (tx) =>
      tx
        .update(schema.waSessions)
        .set({
          status: 'disconnected',
          throttledUntil: null,
          // The multiplier stays raised. Coming off a hold at full speed is
          // how a 24-hour cap becomes a second one.
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.waSessions.status, 'throttled'),
            sql`${schema.waSessions.throttledUntil} is not null`,
            lte(schema.waSessions.throttledUntil, new Date()),
          ),
        )
        .returning({ id: schema.waSessions.id }),
    );
    summary.released = released.length;

    // --- 2. New link requests ---------------------------------------------
    // A row the user created from the browser: a phone number, no credentials
    // yet. Starting the socket is what produces a pairing code.
    const pendingLinks = await asSystem(ctx.db, async (tx) =>
      tx
        .select({
          id: schema.waSessions.id,
          userId: schema.waSessions.userId,
          phoneE164: schema.waSessions.phoneE164,
        })
        .from(schema.waSessions)
        .where(
          and(
            eq(schema.waSessions.status, 'pending'),
            isNull(schema.waSessions.deletedAt),
            isNull(schema.waSessions.credsEncrypted),
            sql`${schema.waSessions.phoneE164} is not null`,
          ),
        )
        .limit(5),
    );

    for (const session of pendingLinks) {
      if (!session.phoneE164 || ctx.wa.has(session.id)) continue;
      try {
        await ctx.wa.startLinking({
          id: session.id,
          userId: session.userId,
          phoneE164: session.phoneE164,
        });
        summary.linked += 1;
      } catch (err) {
        ctx.log.error('failed to start linking', { sessionId: session.id, error: err });
        await asSystem(ctx.db, async (tx) => {
          await tx
            .update(schema.waSessions)
            .set({
              status: 'disconnected',
              lastError: 'Could not reach WhatsApp to start linking',
              updatedAt: new Date(),
            })
            .where(eq(schema.waSessions.id, session.id));
        });
      }
    }

    // --- 3. Linked sessions that should be online -------------------------
    const resumable = await asSystem(ctx.db, async (tx) =>
      tx
        .select({
          id: schema.waSessions.id,
          userId: schema.waSessions.userId,
          credsEncrypted: schema.waSessions.credsEncrypted,
        })
        .from(schema.waSessions)
        .where(
          and(
            isNull(schema.waSessions.deletedAt),
            sql`${schema.waSessions.status} in ('connected', 'disconnected')`,
            sql`${schema.waSessions.credsEncrypted} is not null`,
          ),
        ),
    );

    const live = new Set<string>();
    for (const session of resumable) {
      live.add(session.id);
      if (ctx.wa.has(session.id)) continue;
      try {
        await ctx.wa.resume(session);
        summary.resumed += 1;
      } catch (err) {
        ctx.log.error('failed to resume session', { sessionId: session.id, error: err });
      }
    }

    // --- 4. Sockets the database no longer wants --------------------------
    // Unlinked, soft-deleted, throttled or banned elsewhere. Dropping the
    // socket releases the connection slot back to the user's own phone.
    for (const [sessionId] of Object.entries(ctx.wa.statuses())) {
      const stillWanted =
        live.has(sessionId) || pendingLinks.some((s) => s.id === sessionId);
      if (stillWanted) continue;
      await ctx.wa.drop(sessionId);
      summary.dropped += 1;
    }

    const changed = Object.values(summary).some((n) => n > 0);
    return changed ? { ...summary, open: ctx.wa.size } : undefined;
  },
};

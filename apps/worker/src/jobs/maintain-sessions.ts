import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import {
  acquireSessionLease,
  asSystem,
  pruneExpiredLeases,
  releaseSessionLease,
  renewOwnedSession,
  schema,
} from '@wa/db';
import type { Job } from '../scheduler';
import type { WorkerContext } from '../context';

/**
 * Keeps the set of live WhatsApp sockets in step with the database.
 *
 * The web tier cannot open a socket — it may be running in several processes,
 * and WhatsApp allows one connection per linked device. So linking is a
 * request written to a row, and this job is what notices it. The browser then
 * watches the same row for the pairing code or QR. The database is the
 * message bus; there is no RPC between the two tiers.
 *
 * ONE query decides which sessions should have a socket, and the set of live
 * sockets is diffed against exactly that. The previous version asked three
 * separate questions — "which are pending with no credentials", "which are
 * connected", "which are pairing" — and a session could fall between them.
 *
 * That gap was not hypothetical. Opening a socket writes a partial handshake
 * within milliseconds, so a row sat at `pending` WITH credentials until a code
 * was actually issued. It matched no question: not pending-without-credentials,
 * not connected, not yet pairing. So its socket was dropped on the next tick,
 * five seconds in, and because the row still looked like none of the three
 * cases, nothing ever picked it up again. The user saw a spinner forever and
 * the row went untouched for days.
 *
 * The lesson generalises: derive "what should be running" from one statement
 * and reconcile against it, rather than enumerating cases and hoping they
 * tile the space.
 */

/** Statuses that mean "this session should have a socket". */
const WANTED = ['pending', 'pairing', 'connected', 'disconnected'] as const;

/**
 * Per-session cooldown on starting a handshake.
 *
 * Reconciling every tick means a session whose socket keeps dying would be
 * retried every five seconds, which is how an account gets rate-limited for
 * reconnecting too often. In memory rather than in the row: this is about the
 * behaviour of this process, and a restart genuinely should try again.
 */
const RETRY_COOLDOWN_MS = 20_000;
const lastAttemptAt = new Map<string, number>();

export const maintainSessions: Job = {
  name: 'maintain-sessions',
  everyMs: 5_000,
  // Every session connected and nothing waiting to link. A new link request
  // waits up to 20 seconds for its code, which is noticeable but acceptable;
  // dropping below that costs a query every few seconds, all day, to learn
  // nothing. Any change at all snaps it back to 5 seconds.
  idleEveryMs: 20_000,

  async run(ctx) {
    const summary = {
      linked: 0,
      resumed: 0,
      released: 0,
      dropped: 0,
      leaseHeldElsewhere: 0,
    };

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

    // --- 2. Everything that should have a socket --------------------------
    const wanted = await asSystem(ctx.db, async (tx) =>
      tx
        .select({
          id: schema.waSessions.id,
          userId: schema.waSessions.userId,
          status: schema.waSessions.status,
          phoneE164: schema.waSessions.phoneE164,
          linkMethod: schema.waSessions.linkMethod,
          credsEncrypted: schema.waSessions.credsEncrypted,
        })
        .from(schema.waSessions)
        .where(
          and(
            isNull(schema.waSessions.deletedAt),
            sql`${schema.waSessions.status} in ${WANTED}`,
          ),
        ),
    );

    const wantedIds = new Set(wanted.map((s) => s.id));

    for (const session of wanted) {
      // A live socket is left strictly alone, whatever the row says. This is
      // the check that keeps a handshake in progress from being restarted
      // under the user while they are typing a code.
      //
      // The lease still has to be renewed, though, and losing it is the one
      // reason to let go of a working socket: another worker has taken the
      // session, and two connections to the same linked device get the number
      // logged out.
      if (ctx.wa.has(session.id)) {
        const held = await renewOwnedSession(ctx.db, session.id, ctx.workerId).catch(() => false);
        if (!held) {
          ctx.log.warn('lost session lease, closing socket', {
            sessionId: session.id,
          });
          await ctx.wa.drop(session.id);
          summary.dropped += 1;
        }
        continue;
      }

      const since = Date.now() - (lastAttemptAt.get(session.id) ?? 0);
      if (since < RETRY_COOLDOWN_MS) continue;

      // Nothing opens a socket without the lease. During a deployment overlap
      // the outgoing instance still holds it, and the incoming one simply
      // waits — quietly, because this is the expected state for a few seconds
      // on every deploy rather than a fault.
      const lease = await acquireSessionLease(ctx.db, session.id, ctx.workerId);
      if (!lease.held) {
        summary.leaseHeldElsewhere += 1;
        continue;
      }

      lastAttemptAt.set(session.id, Date.now());

      // Linked already: reconnect with the stored credentials.
      if (session.credsEncrypted && isLinkedStatus(session.status)) {
        try {
          await ctx.wa.resume(session);
          summary.resumed += 1;
        } catch (err) {
          ctx.log.error('failed to resume session', {
            sessionId: session.id,
            error: err,
          });
        }
        continue;
      }

      // Otherwise this is a handshake: either it has not started, or its
      // socket died before completing and it needs a fresh attempt.
      //
      // A pairing code is addressed to a specific number, so one has to be on
      // the row. A QR is not — WhatsApp reports which number scanned it — so
      // phone_e164 is allowed to be NULL there, and passing null is what
      // tells the connection to wait for a scan.
      const pairingPhone =
        session.linkMethod === 'pairing_code' ? session.phoneE164 : null;

      if (session.linkMethod === 'pairing_code' && !pairingPhone) {
        await recordLinkFailure(
          ctx,
          session.id,
          'No phone number to request a code for',
        );
        continue;
      }

      try {
        await ctx.wa.startLinking({
          id: session.id,
          userId: session.userId,
          phoneE164: pairingPhone,
        });
        summary.linked += 1;
        ctx.log.info('started linking handshake', {
          sessionId: session.id,
          method: session.linkMethod,
          restart: session.credsEncrypted !== null,
        });
      } catch (err) {
        ctx.log.error('failed to start linking', {
          sessionId: session.id,
          error: err,
        });
        await recordLinkFailure(
          ctx,
          session.id,
          'Could not reach WhatsApp to start linking',
        );
      }
    }

    // --- 3. Sockets the database no longer wants --------------------------
    // Unlinked, soft-deleted, throttled or banned. Dropping the socket
    // releases the connection slot back to the user's own phone.
    for (const sessionId of Object.keys(ctx.wa.statuses())) {
      if (wantedIds.has(sessionId)) continue;
      await ctx.wa.drop(sessionId);
      // Handing the lease back immediately, rather than waiting for it to
      // lapse, lets another worker pick the session up without a 90-second
      // gap in which nobody owns it.
      await releaseSessionLease(ctx.db, sessionId, ctx.workerId).catch((err) =>
        ctx.log.warn('could not release lease', { sessionId, error: err }),
      );
      lastAttemptAt.delete(sessionId);
      summary.dropped += 1;
    }

    // Cheap, and keeps the lease table readable when something is wrong.
    await pruneExpiredLeases(ctx.db).catch(() => undefined);

    // Forget cooldowns for sessions that no longer exist, so this cannot grow
    // without bound in a long-lived process.
    for (const id of lastAttemptAt.keys()) {
      if (!wantedIds.has(id)) lastAttemptAt.delete(id);
    }

    const changed = Object.values(summary).some((n) => n > 0);
    return changed ? { ...summary, open: ctx.wa.size } : undefined;
  },
};

/** Statuses that mean credentials exist and a socket should just reconnect. */
function isLinkedStatus(status: string): boolean {
  return status === 'connected' || status === 'disconnected';
}

/**
 * Records why a handshake could not start.
 *
 * Left at 'pending' rather than moved to 'disconnected': the user has not
 * linked anything, and 'disconnected' reads as "was working, will come back".
 * The cooldown above is what stops this retrying in a tight loop.
 */
async function recordLinkFailure(
  ctx: WorkerContext,
  sessionId: string,
  message: string,
): Promise<void> {
  await asSystem(ctx.db, async (tx) => {
    await tx
      .update(schema.waSessions)
      .set({ lastError: message, updatedAt: new Date() })
      .where(eq(schema.waSessions.id, sessionId));
  });
}

/**
 * Clears the retry cooldowns.
 *
 * For the verification suite, which drives several reconciliation passes in a
 * few milliseconds and needs each one to act rather than be held off. Nothing
 * in the running worker calls this.
 */
export function resetLinkCooldowns(): void {
  lastAttemptAt.clear();
}

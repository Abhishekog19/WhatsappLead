import { asSystem, sql } from '@wa/db';
import type { Job } from '../scheduler';

/**
 * Recovers targets a dead worker left mid-flight.
 *
 * A worker claims a target by flipping it to `sending` and stamping
 * `claimed_at`. If the process dies before the send completes, the row would
 * sit in `sending` forever and the campaign would never finish. This settles
 * those rows — and the interesting part is that it cannot always settle them
 * as sent or unsent, because sometimes nobody knows.
 *
 * Three distinguishable states, thanks to `dispatch_started_at` being
 * committed before the message is handed to WhatsApp:
 *
 *   marker + message id   -> it went. Settle as sent.
 *   no marker             -> it never left. Safe to retry.
 *   marker, no id         -> AMBIGUOUS. WhatsApp may have delivered it.
 *
 * The third case is the one that matters, and the reason the marker exists.
 * Previously such a row looked identical to one that never left, so it went
 * back in the queue and the recipient got the message twice. A duplicate cold
 * message is worse than a missing one: it is the thing that gets a number
 * reported, and the user cannot un-send it.
 *
 * So ambiguous rows are failed, not retried, with an error that says why.
 * They surface on the campaign page like any other failure, and a human can
 * check the conversation and decide. That is a worse outcome for throughput
 * and the right one for the person on the other end.
 */

/** How long a claim may sit before it is presumed dead. */
const STALL_MS = 10 * 60 * 1_000;

/** Beyond this many tries a target is a poison row, not a transient failure. */
const MAX_ATTEMPTS = 3;

const AMBIGUOUS_ERROR =
  'Interrupted while sending — WhatsApp may already have delivered this. ' +
  'Not retried automatically, to avoid sending a second copy. Check the chat.';

export const reapStaleClaims: Job = {
  name: 'reap-stale-claims',
  everyMs: 60_000,
  // Only finds anything after a crash mid-send. Five clean minutes is good
  // evidence there is nothing to recover.
  idleEveryMs: 300_000,

  async run(ctx) {
    // An ISO string rather than a Date: drizzle hands raw-SQL parameters to
    // postgres-js untyped, and a Date is not serialised there.
    const cutoff = new Date(Date.now() - STALL_MS).toISOString();

    return asSystem(ctx.db, async (tx) => {
      // 1. Sends that demonstrably landed. A message id or a sent_at is proof.
      const settled = await tx.execute(sql`
        update campaign_targets
           set status = 'sent',
               sent_at = coalesce(sent_at, dispatch_started_at, claimed_at),
               claimed_at = null
         where status = 'sending'
           and claimed_at < ${cutoff}::timestamptz
           and (wa_message_id is not null or sent_at is not null)
        returning id`);

      // 2. Dispatched, outcome unknown. Corroborated against message_events in
      // case a delivery receipt arrived for a message whose own row never got
      // written — rare, but it turns an unknown into a known.
      const corroborated = await tx.execute(sql`
        update campaign_targets t
           set status = 'sent',
               sent_at = coalesce(t.sent_at, t.dispatch_started_at),
               claimed_at = null
         where t.status = 'sending'
           and t.claimed_at < ${cutoff}::timestamptz
           and t.dispatch_started_at is not null
           and t.wa_message_id is null
           and exists (
             select 1 from message_events e
              where e.campaign_id = t.campaign_id
                and e.contact_id = t.contact_id
                and e.direction = 'out'
                and e.type in ('sent', 'delivered', 'read')
                and e.occurred_at >= t.dispatch_started_at
           )
        returning id`);

      // 3. Still ambiguous. Refuse to retry; make it visible instead.
      const ambiguous = await tx.execute(sql`
        update campaign_targets
           set status = 'failed',
               claimed_at = null,
               last_error = ${AMBIGUOUS_ERROR}
         where status = 'sending'
           and claimed_at < ${cutoff}::timestamptz
           and dispatch_started_at is not null
           and wa_message_id is null
        returning id`);

      // 4. Never dispatched, retries left: genuinely safe to queue again.
      const released = await tx.execute(sql`
        update campaign_targets
           set status = 'pending',
               claimed_at = null,
               attempts = attempts + 1,
               last_error = 'worker stopped before sending; claim released'
         where status = 'sending'
           and claimed_at < ${cutoff}::timestamptz
           and dispatch_started_at is null
           and wa_message_id is null
           and sent_at is null
           and attempts < ${MAX_ATTEMPTS}
        returning id`);

      // 5. Never dispatched, out of retries.
      const failed = await tx.execute(sql`
        update campaign_targets
           set status = 'failed',
               claimed_at = null,
               last_error = 'abandoned after repeated worker failures'
         where status = 'sending'
           and claimed_at < ${cutoff}::timestamptz
           and dispatch_started_at is null
           and wa_message_id is null
           and sent_at is null
           and attempts >= ${MAX_ATTEMPTS}
        returning id`);

      const counts = {
        settled: settled.length,
        corroborated: corroborated.length,
        ambiguous: ambiguous.length,
        released: released.length,
        failed: failed.length,
      };

      if (counts.ambiguous > 0) {
        // Worth a line of its own: someone may have been messaged twice if
        // this ever reports a number it should not.
        ctx.log.warn('targets left in an unknown delivery state, not retried', {
          count: counts.ambiguous,
        });
      }

      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return total > 0 ? counts : undefined;
    });
  },
};

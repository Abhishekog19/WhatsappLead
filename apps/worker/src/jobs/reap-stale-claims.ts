import { asSystem, sql } from '@wa/db';
import type { Job } from '../scheduler';

/**
 * A worker claims a target by flipping it to `sending` and stamping
 * `claimed_at`. If the process dies between the claim and the send, that row
 * would sit in `sending` forever and the campaign would never finish.
 *
 * This releases claims older than the stall threshold.
 *
 * Honest about the race: a worker can die *after* WhatsApp accepted the
 * message but *before* `wa_message_id` was written, in which case releasing
 * the row risks a duplicate. Rows that already carry a message id or a
 * `sent_at` are therefore settled as sent rather than retried, and the send
 * path (phase 3) will additionally check `message_events` for an outbound
 * record before re-sending. Everything else is a genuine orphan.
 */

/** How long a claim may sit before it is presumed dead. */
const STALL_MS = 10 * 60 * 1_000;

/** Beyond this many tries a target is a poison row, not a transient failure. */
const MAX_ATTEMPTS = 3;

export const reapStaleClaims: Job = {
  name: 'reap-stale-claims',
  everyMs: 60_000,

  async run(ctx) {
    const cutoff = new Date(Date.now() - STALL_MS);

    return asSystem(ctx.db, async (tx) => {
      // Sends that did land: settle them instead of retrying.
      const settled = await tx.execute(sql`
        update campaign_targets
           set status = 'sent',
               sent_at = coalesce(sent_at, claimed_at),
               claimed_at = null
         where status = 'sending'
           and claimed_at < ${cutoff}
           and (wa_message_id is not null or sent_at is not null)
        returning id`);

      // Orphans with retries left: back to the queue.
      const released = await tx.execute(sql`
        update campaign_targets
           set status = 'pending',
               claimed_at = null,
               attempts = attempts + 1,
               last_error = 'worker stopped mid-send; claim released'
         where status = 'sending'
           and claimed_at < ${cutoff}
           and wa_message_id is null
           and sent_at is null
           and attempts < ${MAX_ATTEMPTS}
        returning id`);

      // Orphans out of retries: fail them so the campaign can complete.
      const failed = await tx.execute(sql`
        update campaign_targets
           set status = 'failed',
               claimed_at = null,
               last_error = 'abandoned after repeated worker failures'
         where status = 'sending'
           and claimed_at < ${cutoff}
           and wa_message_id is null
           and sent_at is null
           and attempts >= ${MAX_ATTEMPTS}
        returning id`);

      const counts = {
        settled: settled.length,
        released: released.length,
        failed: failed.length,
      };
      return counts.settled + counts.released + counts.failed > 0 ? counts : undefined;
    });
  },
};

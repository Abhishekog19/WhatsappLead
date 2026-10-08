import { asSystem, sql } from '@wa/db';
import type { Job } from '../scheduler';

/**
 * Keeps `campaigns`' running totals honest, and closes campaigns that have run
 * out of work.
 *
 * The counters on `campaigns` are a denormalised cache of
 * `count(campaign_targets) group by status` — the dashboard reads them on
 * every page load and cannot afford the aggregate. Rather than incrementing
 * them from each of the several places a target can change state (the sender,
 * the dedupe pass, the claim reaper), they are recomputed here from the
 * targets, which are the source of truth. Any drift is self-healing within a
 * minute, and no code path has to remember to bump a number.
 *
 * Scoped to campaigns that could still be moving, so this stays O(active) and
 * not O(all campaigns ever).
 */
export const settleCampaigns: Job = {
  name: 'settle-campaigns',
  everyMs: 60_000,

  async run(ctx) {
    return asSystem(ctx.db, async (tx) => {
      const recounted = await tx.execute(sql`
        with totals as (
          select campaign_id,
                 count(*)::int as total,
                 count(*) filter (where status = 'sent')::int as sent,
                 count(*) filter (where status = 'failed')::int as failed,
                 count(*) filter (where status = 'skipped')::int as skipped,
                 count(*) filter (where status in ('pending', 'sending'))::int as outstanding
            from campaign_targets
           group by campaign_id
        )
        update campaigns c
           set total_targets = t.total,
               sent_count = t.sent,
               failed_count = t.failed,
               skipped_count = t.skipped,
               updated_at = now()
          from totals t
         where t.campaign_id = c.id
           and c.status in ('running', 'paused', 'scheduled')
           and (c.total_targets, c.sent_count, c.failed_count, c.skipped_count)
               is distinct from (t.total, t.sent, t.failed, t.skipped)
        returning c.id`);

      // A running campaign with targets but nothing left outstanding is done.
      // `scheduled` and `paused` are left alone: they are waiting on a clock or
      // on a person, and closing them here would hide that.
      const completed = await tx.execute(sql`
        update campaigns c
           set status = 'completed',
               completed_at = now(),
               updated_at = now()
         where c.status = 'running'
           and c.total_targets > 0
           and not exists (
             select 1 from campaign_targets ct
              where ct.campaign_id = c.id
                and ct.status in ('pending', 'sending')
           )
        returning c.id`);

      const counts = { recounted: recounted.length, completed: completed.length };
      return counts.recounted + counts.completed > 0 ? counts : undefined;
    });
  },
};

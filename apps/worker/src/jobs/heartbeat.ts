import { asSystem, schema } from '@wa/db';
import type { Job } from '../scheduler';

/**
 * Records that this worker is alive and processing.
 *
 * Exists because "nothing is happening" has two very different causes that
 * look identical from the database: a campaign pacing itself between
 * messages, and a campaign whose sender is not running. Without this the
 * campaign page cheerfully explained that messages go out every 25-55 seconds
 * while no worker process existed at all.
 *
 * Written from a scheduled job rather than a timer on purpose. A timer would
 * keep firing while the scheduler was wedged on a stuck job, reporting health
 * the process does not have; a job only runs if the loop is actually turning.
 */
export const heartbeat: Job = {
  name: 'heartbeat',
  everyMs: 10_000,

  async run(ctx) {
    await asSystem(ctx.db, async (tx) => {
      await tx
        .insert(schema.workerHeartbeats)
        .values({
          workerId: ctx.workerId,
          openSessions: ctx.wa.size,
        })
        .onConflictDoUpdate({
          target: schema.workerHeartbeats.workerId,
          set: {
            lastSeenAt: new Date(),
            openSessions: ctx.wa.size,
          },
        });
    });

    // Silent: this runs every ten seconds and a log line per beat would bury
    // everything worth reading.
    return undefined;
  },
};

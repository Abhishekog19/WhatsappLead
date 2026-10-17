import { and, eq, sql } from 'drizzle-orm';
import {
  effectiveCap,
  isWithinSendWindow,
  jitterBatchSize,
  nextBatchPauseMs,
  nextDelayMs,
  pickVariant,
  renderTemplate,
  typingDurationMs,
  maskPhone,
  THROTTLE_RESPONSE,
  type AccountType,
  type ThrottleSignal,
  type Tier,
} from '@wa/core';
import { asSystem, schema } from '@wa/db';
import { classifyThrottle } from '@wa/wa';
import type { Job } from '../scheduler';
import type { WorkerContext } from '../context';

/**
 * The send loop.
 *
 * Shape of the thing: this job runs every few seconds and sends AT MOST ONE
 * message per campaign per tick. It does not sit in a loop sleeping for
 * forty seconds between sends.
 *
 * That matters for three reasons. A blocking loop would monopolise the
 * scheduler and stall the maintenance jobs. It would make several concurrent
 * campaigns take turns rather than run alongside each other. And it would
 * make every pause uninterruptible, so a user hitting "pause" would wait out
 * the current sleep before anything happened.
 *
 * Instead each campaign carries a small piece of in-memory state saying when
 * it may next send. Losing that state on restart is harmless: a restarted
 * worker re-seeds it with a fresh randomised delay, which at worst costs one
 * extra pause.
 *
 * What is NOT in memory is anything that must survive a crash. Every target's
 * progress, every quota row and every delivery outcome is written to Postgres
 * as it happens, which is what makes an interrupted campaign resumable
 * without re-messaging anyone.
 */

/**
 * The in-memory half of the pacer.
 *
 * The parts that MUST survive a restart — when the next message may go out,
 * and how far into the current batch we are — live on the campaign row. This
 * holds only what is safe to lose: the jittered batch target, which is
 * re-rolled anyway, and log throttling.
 *
 * That split matters more here than it sounds. A free instance spins down
 * after fifteen idle minutes and may be recycled at any time, so restarts are
 * routine rather than exceptional. With the whole pacer in memory, every
 * restart reset it: the inter-message delay was skipped, and so was the
 * 45-90 minute pause between batches. Pacing exists to look human, and a
 * limit a restart bypasses is not a limit.
 */
interface PacerState {
  /** Jittered, so the rhythm is not "exactly 15, pause, exactly 15". */
  batchTarget: number;
  /** Suppresses repeated "budget exhausted" logging. */
  quietUntil: number;
}

const pacers = new Map<string, PacerState>();

/** Skipped targets cost no WhatsApp traffic, so a tick may clear several. */
const MAX_SKIPS_PER_TICK = 50;

export const sendCampaigns: Job = {
  name: 'send-campaigns',
  everyMs: 3_000,
  // Nothing is running: a campaign only becomes due when someone starts one,
  // and 20 seconds of extra latency before its first message is invisible
  // next to the 25-55 second gap between every message after it.
  idleEveryMs: 20_000,

  async run(ctx, signal) {
    const due = await loadRunnableCampaigns(ctx);

    // Forget pacers for campaigns that stopped, so the map cannot grow
    // without bound in a long-lived process.
    const liveIds = new Set(due.map((c) => c.campaignId));
    for (const id of pacers.keys()) if (!liveIds.has(id)) pacers.delete(id);

    const summary = { sent: 0, skipped: 0, failed: 0, held: 0 };

    for (const campaign of due) {
      if (signal.aborted) break;
      const result = await runOneCampaign(ctx, campaign, signal);
      summary.sent += result.sent;
      summary.skipped += result.skipped;
      summary.failed += result.failed;
      summary.held += result.held;
    }

    const did = summary.sent + summary.skipped + summary.failed;
    return did > 0 ? summary : undefined;
  },
};

// ---------------------------------------------------------------------------

interface RunnableCampaign {
  campaignId: string;
  userId: string;
  sessionId: string;
  templateId: string;
  dailyCapOverride: number | null;
  /** Durable pacing: see the note on PacerState. */
  nextSendAt: Date | null;
  batchSentCount: number;
  // Session
  accountType: AccountType;
  tier: number;
  linkedAt: Date | null;
  delayMultiplier: number;
  throttledUntil: Date | null;
  sessionStatus: string;
  // Settings
  dedupeMode: 'never_repeat' | 'cooldown' | 'off';
  cooldownDays: number;
  newContactCap24h: number | null;
  warmupEnabled: boolean;
  minDelayMs: number;
  maxDelayMs: number;
  batchSize: number;
  minBatchPauseMs: number;
  maxBatchPauseMs: number;
  simulateTyping: boolean;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
  timezone: string;
  skipWeekends: boolean;
}

async function loadRunnableCampaigns(ctx: WorkerContext): Promise<RunnableCampaign[]> {
  return asSystem(ctx.db, async (tx) => {
    const rows = await tx
      .select({
        campaignId: schema.campaigns.id,
        userId: schema.campaigns.userId,
        sessionId: schema.campaigns.sessionId,
        templateId: schema.campaigns.templateId,
        dailyCapOverride: schema.campaigns.dailyCapOverride,
        nextSendAt: schema.campaigns.nextSendAt,
        batchSentCount: schema.campaigns.batchSentCount,

        accountType: schema.waSessions.accountType,
        tier: schema.waSessions.tier,
        linkedAt: schema.waSessions.linkedAt,
        delayMultiplier: schema.waSessions.delayMultiplier,
        throttledUntil: schema.waSessions.throttledUntil,
        sessionStatus: schema.waSessions.status,

        dedupeMode: schema.settings.dedupeMode,
        cooldownDays: schema.settings.cooldownDays,
        newContactCap24h: schema.settings.newContactCap24h,
        warmupEnabled: schema.settings.warmupEnabled,
        minDelayMs: schema.settings.minDelayMs,
        maxDelayMs: schema.settings.maxDelayMs,
        batchSize: schema.settings.batchSize,
        minBatchPauseMs: schema.settings.minBatchPauseMs,
        maxBatchPauseMs: schema.settings.maxBatchPauseMs,
        simulateTyping: schema.settings.simulateTyping,
        sendWindowStartHour: schema.settings.sendWindowStartHour,
        sendWindowEndHour: schema.settings.sendWindowEndHour,
        timezone: schema.settings.timezone,
        skipWeekends: schema.settings.skipWeekends,
      })
      .from(schema.campaigns)
      .innerJoin(schema.waSessions, eq(schema.waSessions.id, schema.campaigns.sessionId))
      .innerJoin(schema.settings, eq(schema.settings.userId, schema.campaigns.userId))
      .where(eq(schema.campaigns.status, 'running'));

    return rows as RunnableCampaign[];
  });
}

interface TickResult {
  sent: number;
  skipped: number;
  failed: number;
  held: number;
}

async function runOneCampaign(
  ctx: WorkerContext,
  campaign: RunnableCampaign,
  signal: AbortSignal,
): Promise<TickResult> {
  const result: TickResult = { sent: 0, skipped: 0, failed: 0, held: 0 };
  // An overlapping deployment without this session must not overwrite its
  // durable pacer while the owning worker is sending.
  if (!ctx.wa.get(campaign.sessionId)?.isConnected) return result;
  const now = Date.now();

  const pacer = pacers.get(campaign.campaignId) ?? seedPacer(campaign);
  pacers.set(campaign.campaignId, pacer);

  // The due time comes off the row, so a restart cannot skip the wait. A
  // campaign that has never sent has no next_send_at; start it promptly, with
  // a little jitter so a restart does not fire every campaign at once.
  if (campaign.nextSendAt === null) {
    await holdUntil(
      ctx,
      campaign.campaignId,
      new Date(now + Math.floor(Math.random() * 10_000)),
    );
    return result;
  }
  if (now < campaign.nextSendAt.getTime()) return result;

  // --- Gates. Each is a reason to do nothing, not a reason to fail. --------

  const conn = ctx.wa.get(campaign.sessionId);
  if (!conn?.isConnected || campaign.sessionStatus !== 'connected') {
    // maintain-sessions owns reconnecting. Re-check in a few seconds.
    await holdUntil(ctx, campaign.campaignId, new Date(now + 10_000));
    result.held += 1;
    return result;
  }

  if (campaign.throttledUntil && campaign.throttledUntil.getTime() > now) {
    // Held until the throttle expires, and no further. Reconnecting or
    // retrying into a cap is what turns a temporary hold into a ban.
    await holdUntil(ctx, campaign.campaignId, campaign.throttledUntil);
    result.held += 1;
    return result;
  }

  const window = {
    startHour: campaign.sendWindowStartHour,
    endHour: campaign.sendWindowEndHour,
    timezone: campaign.timezone,
    skipWeekends: campaign.skipWeekends,
  };
  if (!isWithinSendWindow(new Date(now), window)) {
    // Checking every 5 minutes is precise enough for an hour-granularity
    // window and avoids recomputing timezone maths every tick.
    await holdUntil(ctx, campaign.campaignId, new Date(now + 5 * 60_000));
    result.held += 1;
    return result;
  }

  const budget = await remainingBudget(ctx, campaign);
  if (budget <= 0) {
    await holdUntil(ctx, campaign.campaignId, new Date(now + 10 * 60_000));
    if (now > pacer.quietUntil) {
      ctx.log.info('daily cap reached, holding', {
        campaignId: campaign.campaignId,
        sessionId: campaign.sessionId,
      });
      pacer.quietUntil = now + 60 * 60_000;
    }
    result.held += 1;
    return result;
  }

  // --- Clear anything that needs no WhatsApp traffic -----------------------
  // Suppressed and duplicate targets are decided entirely in the database, so
  // burning a 40-second human-pacing delay on them would be absurd.
  for (let i = 0; i < MAX_SKIPS_PER_TICK; i++) {
    if (signal.aborted) return result;
    const claimed = await claimTarget(ctx, campaign);
    if (!claimed) return result;

    const skip = await evaluateSkip(ctx, campaign, claimed);
    if (skip) {
      await asSystem(ctx.db, async (tx) => {
        await tx
          .update(schema.campaignTargets)
          .set({ status: 'skipped', skipReason: skip, claimedAt: null })
          .where(eq(schema.campaignTargets.id, claimed.targetId));
      });
      result.skipped += 1;
      continue;
    }

    // A real send. Do it, then stop — one message per campaign per tick.
    // Reserve pacing before any socket write. A crash can add a delay, but
    // must never erase a committed cooldown.
    await advancePacer(ctx, pacer, campaign);
    const outcome = await sendOne(ctx, campaign, claimed);
    if (outcome === 'sent') result.sent += 1;
    else result.failed += 1;

    return result;
  }

  return result;
}

function seedPacer(campaign: RunnableCampaign): PacerState {
  return {
    batchTarget: jitterBatchSize(campaign.batchSize),
    quietUntil: 0,
  };
}

/** Pushes the campaign's next-send time out, durably. */
async function holdUntil(
  ctx: WorkerContext,
  campaignId: string,
  when: Date,
): Promise<void> {
  await asSystem(ctx.db, async (tx) => {
    await tx
      .update(schema.campaigns)
      .set({ nextSendAt: when })
      .where(eq(schema.campaigns.id, campaignId));
  });
}

/**
 * Records that a message just went out, and when the next one may.
 *
 * Written to the row rather than held in memory so a restart cannot skip the
 * wait. One extra UPDATE per message, against a gap of 25-55 seconds.
 */
async function advancePacer(
  ctx: WorkerContext,
  pacer: PacerState,
  campaign: RunnableCampaign,
): Promise<void> {
  const sentInBatch = campaign.batchSentCount + 1;

  if (sentInBatch >= pacer.batchTarget) {
    const pause = nextBatchPauseMs(campaign);
    pacer.batchTarget = jitterBatchSize(campaign.batchSize);
    await asSystem(ctx.db, async (tx) => {
      await tx
        .update(schema.campaigns)
        .set({ nextSendAt: new Date(Date.now() + pause), batchSentCount: 0 })
        .where(eq(schema.campaigns.id, campaign.campaignId));
    });
    ctx.log.info('batch complete, pausing', {
      campaignId: campaign.campaignId,
      pauseMinutes: Math.round(pause / 60_000),
    });
    return;
  }

  const delay = nextDelayMs(campaign, campaign.delayMultiplier);
  await asSystem(ctx.db, async (tx) => {
    await tx
      .update(schema.campaigns)
      .set({
        nextSendAt: new Date(Date.now() + delay),
        batchSentCount: sentInBatch,
      })
      .where(eq(schema.campaigns.id, campaign.campaignId));
  });
}

/**
 * How many more new contacts this number may message in the rolling window.
 *
 * Counted from `new_contact_sends`, not from a daily counter, so there is no
 * midnight boundary to exploit and a restart cannot lose track of it.
 */
async function remainingBudget(
  ctx: WorkerContext,
  campaign: RunnableCampaign,
): Promise<number> {
  const used = await asSystem(ctx.db, async (tx) => {
    const rows = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n
        from new_contact_sends
       where session_id = ${campaign.sessionId}
         and sent_at > now() - interval '24 hours'
    `);
    return Number(rows[0]?.n ?? 0);
  });

  const daysSinceLink = campaign.linkedAt
    ? Math.floor((Date.now() - campaign.linkedAt.getTime()) / 86_400_000) + 1
    : 1;

  const cap = effectiveCap({
    accountType: campaign.accountType,
    tier: clampTier(campaign.tier),
    daysSinceLink,
    warmupEnabled: campaign.warmupEnabled,
    // A per-campaign override may lower the ceiling but never raise it;
    // effectiveCap takes the minimum of everything it is given.
    userCap: campaign.dailyCapOverride ?? campaign.newContactCap24h,
    platformCeiling: ctx.env.PLATFORM_MAX_NEW_CONTACTS_24H,
  });

  return cap - used;
}

function clampTier(tier: number): Tier {
  if (tier <= 1) return 1;
  if (tier >= 4) return 4;
  return tier as Tier;
}

interface ClaimedTarget {
  targetId: string;
  contactId: string;
  phoneE164: string;
  name: string | null;
  fields: Record<string, string>;
  lastMessagedAt: Date | null;
  onWhatsapp: 'yes' | 'no' | null;
  attempts: number;
}

/**
 * Takes exactly one pending target, marking it `sending` so no other worker
 * picks it up.
 *
 * `for update skip locked` is what makes running several workers safe: each
 * one takes a different row rather than blocking on the same one, and a
 * crashed worker's claim is recovered by the reaper rather than wedging the
 * queue.
 */
async function claimTarget(
  ctx: WorkerContext,
  campaign: RunnableCampaign,
): Promise<ClaimedTarget | null> {
  return asSystem(ctx.db, async (tx) => {
    const rows = await tx.execute<{
      target_id: string;
      contact_id: string;
      phone_e164: string;
      name: string | null;
      fields: Record<string, string>;
      last_messaged_at: Date | null;
      on_whatsapp: 'yes' | 'no' | null;
      attempts: number;
    }>(sql`
      with claimed as (
        select t.id
          from campaign_targets t
         where t.campaign_id = ${campaign.campaignId}
           and t.status = 'pending'
         order by t.created_at
         for update skip locked
         limit 1
      )
      update campaign_targets t
         set status = 'sending', claimed_at = now()
        from claimed c, contacts ct
       where t.id = c.id
         and ct.id = t.contact_id
      returning
        t.id            as target_id,
        t.attempts      as attempts,
        ct.id           as contact_id,
        ct.phone_e164   as phone_e164,
        ct.name         as name,
        ct.fields       as fields,
        ct.last_messaged_at as last_messaged_at,
        ct.on_whatsapp  as on_whatsapp
    `);

    const r = rows[0];
    if (!r) return null;
    return {
      targetId: r.target_id,
      contactId: r.contact_id,
      phoneE164: r.phone_e164,
      name: r.name,
      fields: r.fields ?? {},
      lastMessagedAt: r.last_messaged_at,
      onWhatsapp: r.on_whatsapp,
      attempts: r.attempts,
    };
  });
}

/**
 * Decides whether this target must not be messaged.
 *
 * Order matters: suppression is checked first because it is the rule a user
 * cannot switch off, and it must win regardless of how dedupe is configured.
 */
async function evaluateSkip(
  ctx: WorkerContext,
  campaign: RunnableCampaign,
  target: ClaimedTarget,
): Promise<'suppressed' | 'duplicate' | 'cooldown' | 'not_on_whatsapp' | null> {
  const suppressed = await asSystem(ctx.db, async (tx) => {
    const rows = await tx
      .select({ id: schema.suppressions.id })
      .from(schema.suppressions)
      .where(
        and(
          eq(schema.suppressions.userId, campaign.userId),
          eq(schema.suppressions.phoneE164, target.phoneE164),
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
  if (suppressed) return 'suppressed';

  const unknown = await asSystem(ctx.db, async (tx) => tx.execute(sql`
    select 1 from campaign_targets
    where user_id = ${campaign.userId} and contact_id = ${target.contactId}
      and dispatch_started_at is not null and sent_at is null
      and status in ('failed', 'sending') and id <> ${target.targetId}
    limit 1
  `));
  if (unknown.length) return 'suppressed';

  // Dedupe is per account and entirely the user's choice. One user's history
  // never constrains another's: every table consulted here is scoped by
  // user_id, and row-level security enforces that independently.
  if (campaign.dedupeMode === 'never_repeat' && target.lastMessagedAt) {
    return 'duplicate';
  }
  if (campaign.dedupeMode === 'cooldown' && target.lastMessagedAt) {
    const elapsedDays =
      (Date.now() - target.lastMessagedAt.getTime()) / 86_400_000;
    if (elapsedDays < campaign.cooldownDays) return 'cooldown';
  }

  // Scraped business listings are full of landlines. Checking costs one
  // lookup and is cached on the contact; sending to a number with no
  // WhatsApp account wastes quota and looks like spraying.
  if (target.onWhatsapp === 'no') return 'not_on_whatsapp';
  if (target.onWhatsapp === null) {
    const conn = ctx.wa.get(campaign.sessionId);
    if (conn?.isConnected) {
      try {
        const found = await conn.checkOnWhatsApp([target.phoneE164]);
        const exists = found.get(target.phoneE164) ?? false;
        await asSystem(ctx.db, async (tx) => {
          await tx
            .update(schema.contacts)
            .set({
              onWhatsapp: exists ? 'yes' : 'no',
              onWhatsappCheckedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.contacts.id, target.contactId));
        });
        if (!exists) return 'not_on_whatsapp';
      } catch (err) {
        // A failed lookup is not a reason to skip someone — fall through and
        // let the send itself be the test.
        ctx.log.debug('onWhatsApp check failed', { error: err });
      }
    }
  }

  return null;
}

async function sendOne(
  ctx: WorkerContext,
  campaign: RunnableCampaign,
  target: ClaimedTarget,
): Promise<'sent' | 'failed'> {
  const conn = ctx.wa.get(campaign.sessionId);
  if (!conn?.isConnected) {
    await releaseTarget(ctx, target, 'Socket went down before sending');
    return 'failed';
  }

  // --- Render -------------------------------------------------------------
  const variants = await asSystem(ctx.db, async (tx) =>
    tx
      .select({
        id: schema.templateVariants.id,
        body: schema.templateVariants.body,
        weight: schema.templateVariants.weight,
      })
      .from(schema.templateVariants)
      .where(
        and(
          eq(schema.templateVariants.templateId, campaign.templateId),
          sql`${schema.templateVariants.weight} > 0`,
        ),
      )
      .orderBy(schema.templateVariants.position),
  );

  if (variants.length === 0) {
    await failTarget(ctx, target, 'Template has no active variants');
    await pauseCampaign(ctx, campaign.campaignId, 'Template has no active variants');
    return 'failed';
  }

  // Seeded by contact id so a retry after a crash reuses the same wording
  // rather than sending the person a second, differently-phrased message.
  const variant = pickVariant(variants, target.contactId)!;
  const rendered = renderTemplate(variant.body, {
    ...target.fields,
    name: target.name ?? '',
    phone: target.phoneE164,
  });

  if (!rendered.text.trim()) {
    await failTarget(ctx, target, 'Rendered message was empty');
    return 'failed';
  }

  // --- Send ---------------------------------------------------------------
  //
  // The intent is committed BEFORE the socket write, and that ordering is the
  // whole point. A worker killed between handing the message to WhatsApp and
  // writing the result leaves a row that looks untouched — so the reaper used
  // to put it back in the queue and someone received the message twice.
  //
  // With this marker the three cases are distinguishable: no marker means it
  // never left, a marker with a message id means it went, and a marker
  // without one means nobody knows. The third is not retried.
  //
  // One extra UPDATE against a 25-55 second gap between messages.
  await asSystem(ctx.db, async (tx) => {
    await tx
      .update(schema.campaignTargets)
      .set({ dispatchStartedAt: new Date(), renderedBody: rendered.text, variantId: variant.id })
      .where(eq(schema.campaignTargets.id, target.targetId));
  });

  try {
    const typingMs = campaign.simulateTyping ? typingDurationMs(rendered.text) : 0;
    const sent = await conn.sendText(target.phoneE164, rendered.text, { typingMs });

    // A contact nobody has messaged before is what consumes the rolling
    // quota. Follow-ups into an existing thread do not.
    const isNewContact = target.lastMessagedAt === null;

    await asSystem(ctx.db, async (tx) => {
      await tx
        .update(schema.campaignTargets)
        .set({
          status: 'sent',
          sentAt: sent.sentAt,
          waMessageId: sent.waMessageId,
          renderedBody: rendered.text,
          variantId: variant.id,
          claimedAt: null,
          lastError: null,
        })
        .where(eq(schema.campaignTargets.id, target.targetId));

      await tx
        .update(schema.contacts)
        .set({
          lastMessagedAt: sent.sentAt,
          messageCount: sql`${schema.contacts.messageCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(schema.contacts.id, target.contactId));

      if (isNewContact) {
        await tx.insert(schema.newContactSends).values({
          userId: campaign.userId,
          sessionId: campaign.sessionId,
          contactId: target.contactId,
          campaignId: campaign.campaignId,
          phoneE164: target.phoneE164,
          sentAt: sent.sentAt,
        });
      }

      await tx.insert(schema.messageEvents).values({
        userId: campaign.userId,
        sessionId: campaign.sessionId,
        contactId: target.contactId,
        campaignId: campaign.campaignId,
        direction: 'out',
        type: 'sent',
        waMessageId: sent.waMessageId,
        occurredAt: sent.sentAt,
      });

      await tx
        .update(schema.templateVariants)
        .set({
          sentCount: sql`${schema.templateVariants.sentCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(schema.templateVariants.id, variant.id));
    });

    ctx.log.info('message sent', {
      campaignId: campaign.campaignId,
      to: maskPhone(target.phoneE164),
      variant: variant.id,
      newContact: isNewContact,
    });
    return 'sent';
  } catch (err) {
    const throttle = classifyThrottle(err);
    if (throttle) {
      // Not a failed message so much as an instruction. Put the target back,
      // record the signal, and stop the campaign — retrying into a cap is
      // what escalates it.
      ctx.log.warn('throttle signal while sending', {
        campaignId: campaign.campaignId,
        signal: throttle,
      });
      await failTarget(ctx, target, `Delivery unknown; review before retrying. WhatsApp signalled ${throttle}`);
      await recordSendThrottle(ctx, campaign, throttle, err);
      return 'failed';
    }

    // A timeout or a failed ledger transaction does not prove non-delivery.
    // Keep the dispatch marker and never automatically retry this recipient.
    const message = 'Delivery unknown after dispatch; review WhatsApp before retrying.';
    await failTarget(ctx, target, message);
    await pauseCampaign(ctx, campaign.campaignId, message);
    ctx.log.warn('send failed', {
      campaignId: campaign.campaignId,
      to: maskPhone(target.phoneE164),
      attempts: target.attempts + 1,
      error: message,
    });
    return 'failed';
  }
}

/** Safe retry only before dispatch begins (for example, no connected socket). */
async function releaseTarget(
  ctx: WorkerContext,
  target: ClaimedTarget,
  error: string,
): Promise<void> {
  await asSystem(ctx.db, async (tx) => {
    await tx
      .update(schema.campaignTargets)
      .set({
        status: 'pending',
        attempts: sql`${schema.campaignTargets.attempts} + 1`,
        lastError: error.slice(0, 500),
        claimedAt: null,
        dispatchStartedAt: null,
      })
      .where(eq(schema.campaignTargets.id, target.targetId));
  });
}

/** Out of attempts. */
async function failTarget(
  ctx: WorkerContext,
  target: ClaimedTarget,
  error: string,
): Promise<void> {
  await asSystem(ctx.db, async (tx) => {
    await tx
      .update(schema.campaignTargets)
      .set({
        status: 'failed',
        attempts: sql`${schema.campaignTargets.attempts} + 1`,
        lastError: error.slice(0, 500),
        claimedAt: null,
      })
      .where(eq(schema.campaignTargets.id, target.targetId));
  });
}

async function pauseCampaign(
  ctx: WorkerContext,
  campaignId: string,
  reason: string,
): Promise<void> {
  await asSystem(ctx.db, async (tx) => {
    await tx
      .update(schema.campaigns)
      .set({
        status: 'paused',
        pausedAt: new Date(),
        pauseReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(schema.campaigns.id, campaignId));
  });
  pacers.delete(campaignId);
}

/**
 * A throttle seen on a send rather than on a disconnect.
 *
 * The connection-level handler in @wa/wa only fires when the socket closes;
 * a rate limit returned by sendMessage leaves the socket up, so the same
 * response has to be applied from here.
 */
async function recordSendThrottle(
  ctx: WorkerContext,
  campaign: RunnableCampaign,
  signal: ThrottleSignal,
  raw: unknown,
): Promise<void> {
  const response = THROTTLE_RESPONSE[signal];
  const pausedUntil =
    response.pauseMs > 0 ? new Date(Date.now() + response.pauseMs) : null;
  const tierAfter = response.resetToTier1
    ? 1
    : Math.max(1, campaign.tier - response.tierDrop);

  await asSystem(ctx.db, async (tx) => {
    await tx
      .update(schema.waSessions)
      .set({
        status: 'throttled',
        tier: tierAfter,
        tierUpdatedAt: new Date(),
        cleanDays: 0,
        delayMultiplier: Math.max(campaign.delayMultiplier, response.delayMultiplier),
        ...(pausedUntil ? { throttledUntil: pausedUntil } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.waSessions.id, campaign.sessionId));

    await tx.insert(schema.throttleEvents).values({
      userId: campaign.userId,
      sessionId: campaign.sessionId,
      signal,
      raw: {
        message: raw instanceof Error ? raw.message : String(raw),
        source: 'sendMessage',
      },
      tierBefore: campaign.tier,
      tierAfter,
      pausedUntil,
    });
  });

  await pauseCampaign(ctx, campaign.campaignId, `WhatsApp signalled ${signal}`);
}

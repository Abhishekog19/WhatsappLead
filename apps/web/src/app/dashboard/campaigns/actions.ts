'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  and,
  auditLog,
  campaigns,
  campaignTargets,
  contactLists,
  contacts,
  eq,
  isNull,
  sql,
  templates,
  templateVariants,
  waSessions,
} from '@wa/db';
import { queryAsUser } from '@/server/session';

/**
 * Campaign lifecycle.
 *
 * Creating a campaign materialises one `campaign_targets` row per contact,
 * rather than streaming the list at send time. That costs an insert up front
 * and buys three things: the total is known immediately so progress is
 * meaningful, a contact added to the list afterwards does not silently join a
 * campaign in flight, and every target carries its own status so an
 * interrupted run resumes exactly where it stopped.
 */

export interface CampaignResult {
  ok: boolean;
  message: string;
  campaignId?: string;
}

const createSchema = z.object({
  name: z.string().trim().min(1, 'Name this campaign.').max(80),
  sessionId: z.string().uuid('Choose a WhatsApp number.'),
  listId: z.string().uuid('Choose a contact list.'),
  templateId: z.string().uuid('Choose a message.'),
  dailyCapOverride: z
    .union([z.coerce.number().int().min(1).max(500), z.literal('')])
    .transform((v) => (v === '' ? null : v)),
  startNow: z.coerce.boolean(),
});

export async function createCampaign(
  _prev: CampaignResult | null,
  formData: FormData,
): Promise<CampaignResult> {
  const parsed = createSchema.safeParse({
    name: formData.get('name'),
    sessionId: formData.get('sessionId'),
    listId: formData.get('listId'),
    templateId: formData.get('templateId'),
    dailyCapOverride: formData.get('dailyCapOverride') ?? '',
    startNow: formData.get('startNow') === 'on',
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Check the form.',
    };
  }

  const { name, sessionId, listId, templateId, dailyCapOverride, startNow } =
    parsed.data;

  const outcome = await queryAsUser(async (tx, userId) => {
    // Ownership is enforced by row-level security, but checking explicitly
    // turns "silently zero contacts" into a clear message.
    const [session] = await tx
      .select({ id: waSessions.id, status: waSessions.status })
      .from(waSessions)
      .where(
        and(
          eq(waSessions.id, sessionId),
          eq(waSessions.userId, userId),
          isNull(waSessions.deletedAt),
        ),
      )
      .limit(1);

    if (!session) return { ok: false as const, message: 'That number is not available.' };

    const [activeVariants] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(templateVariants)
      .where(
        and(
          eq(templateVariants.templateId, templateId),
          eq(templateVariants.userId, userId),
          sql`${templateVariants.weight} > 0`,
          sql`length(trim(${templateVariants.body})) > 0`,
        ),
      );

    if (Number(activeVariants?.n ?? 0) === 0) {
      return {
        ok: false as const,
        message: 'That message is empty. Write it before starting a campaign.',
      };
    }

    const [template] = await tx
      .select({ id: templates.id })
      .from(templates)
      .where(
        and(
          eq(templates.id, templateId),
          eq(templates.userId, userId),
          isNull(templates.deletedAt),
        ),
      )
      .limit(1);
    if (!template) return { ok: false as const, message: 'Message not found.' };

    const [list] = await tx
      .select({ id: contactLists.id })
      .from(contactLists)
      .where(
        and(
          eq(contactLists.id, listId),
          eq(contactLists.userId, userId),
          isNull(contactLists.deletedAt),
        ),
      )
      .limit(1);
    if (!list) return { ok: false as const, message: 'Contact list not found.' };

    const [campaign] = await tx
      .insert(campaigns)
      .values({
        userId,
        name,
        sessionId,
        listId,
        templateId,
        dailyCapOverride,
        // 'draft' until the targets exist, so a half-built campaign can never
        // be picked up by the worker.
        status: 'draft',
      })
      .returning({ id: campaigns.id });

    if (!campaign) return { ok: false as const, message: 'Could not create the campaign.' };

    // One statement: select the list's contacts and insert a target for each.
    // Doing this in SQL keeps a 20,000-row list from travelling through Node.
    const inserted = await tx.execute<{ n: number }>(sql`
      with inserted as (
        insert into campaign_targets (campaign_id, user_id, contact_id)
        select ${campaign.id}, ${userId}, c.id
          from contacts c
         where c.user_id = ${userId}
           and c.list_id = ${listId}
        on conflict (campaign_id, contact_id) do nothing
        returning 1
      )
      select count(*)::int as n from inserted
    `);

    const total = Number(inserted[0]?.n ?? 0);

    if (total === 0) {
      // Roll the empty campaign back rather than leaving a confusing husk.
      await tx.delete(campaigns).where(eq(campaigns.id, campaign.id));
      return {
        ok: false as const,
        message: 'That list has no contacts in it.',
      };
    }

    await tx
      .update(campaigns)
      .set({
        totalTargets: total,
        status: startNow ? 'running' : 'draft',
        ...(startNow ? { startedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaign.id));

    await tx.insert(auditLog).values({
      userId,
      action: 'campaign.create',
      entityType: 'campaign',
      entityId: campaign.id,
      metadata: { total, startNow, dailyCapOverride },
    });

    return { ok: true as const, campaignId: campaign.id, total };
  });

  if (!outcome.ok) return outcome;

  revalidatePath('/dashboard/campaigns');
  revalidatePath('/dashboard');
  redirect(`/dashboard/campaigns/${outcome.campaignId}`);
}

// ---------------------------------------------------------------------------

export async function startCampaign(campaignId: string): Promise<CampaignResult> {
  return queryAsUser(async (tx, userId) => {
    const [campaign] = await tx
      .select({
        status: campaigns.status,
        sessionStatus: waSessions.status,
        throttledUntil: waSessions.throttledUntil,
      })
      .from(campaigns)
      .innerJoin(waSessions, eq(waSessions.id, campaigns.sessionId))
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
      .limit(1);

    if (!campaign) return { ok: false, message: 'Campaign not found.' };

    if (campaign.status === 'running') {
      return { ok: true, message: 'Already running.' };
    }
    if (campaign.status === 'completed' || campaign.status === 'cancelled') {
      return { ok: false, message: 'This campaign has finished.' };
    }

    if (campaign.sessionStatus === 'banned' || campaign.sessionStatus === 'logged_out') {
      return {
        ok: false,
        message: 'Re-link the WhatsApp number before starting this campaign.',
      };
    }

    if (campaign.throttledUntil && campaign.throttledUntil.getTime() > Date.now()) {
      return {
        ok: false,
        message: `WhatsApp is holding this number until ${campaign.throttledUntil.toLocaleString()}.`,
      };
    }

    await tx
      .update(campaigns)
      .set({
        status: 'running',
        startedAt: sql`coalesce(${campaigns.startedAt}, now())`,
        pausedAt: null,
        pauseReason: null,
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));

    await tx.insert(auditLog).values({
      userId,
      action: 'campaign.start',
      entityType: 'campaign',
      entityId: campaignId,
    });

    revalidatePath(`/dashboard/campaigns/${campaignId}`);
    revalidatePath('/dashboard');
    return { ok: true, message: 'Campaign started.' };
  });
}

export async function pauseCampaign(campaignId: string): Promise<CampaignResult> {
  return queryAsUser(async (tx, userId) => {
    const result = await tx
      .update(campaigns)
      .set({
        status: 'paused',
        pausedAt: new Date(),
        pauseReason: 'Paused by you',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(campaigns.id, campaignId),
          eq(campaigns.userId, userId),
          eq(campaigns.status, 'running'),
        ),
      )
      .returning({ id: campaigns.id });

    if (!result[0]) return { ok: false, message: 'Campaign is not running.' };

    await tx.insert(auditLog).values({
      userId,
      action: 'campaign.pause',
      entityType: 'campaign',
      entityId: campaignId,
    });

    revalidatePath(`/dashboard/campaigns/${campaignId}`);
    revalidatePath('/dashboard');
    return { ok: true, message: 'Paused. Nothing more will be sent.' };
  });
}

/**
 * Cancels a campaign and drops everything still queued.
 *
 * Deliberately irreversible: leaving the pending targets in place would make
 * "cancel" indistinguishable from "pause", and a user who cancels wants the
 * queue gone.
 */
export async function cancelCampaign(campaignId: string): Promise<CampaignResult> {
  return queryAsUser(async (tx, userId) => {
    const [campaign] = await tx
      .select({ status: campaigns.status })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
      .limit(1);

    if (!campaign) return { ok: false, message: 'Campaign not found.' };
    if (campaign.status === 'completed' || campaign.status === 'cancelled') {
      return { ok: false, message: 'This campaign has already finished.' };
    }

    const dropped = await tx
      .update(campaignTargets)
      .set({ status: 'skipped', skipReason: 'cap_reached' })
      .where(
        and(
          eq(campaignTargets.campaignId, campaignId),
          eq(campaignTargets.userId, userId),
          eq(campaignTargets.status, 'pending'),
        ),
      )
      .returning({ id: campaignTargets.id });

    await tx
      .update(campaigns)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        pauseReason: 'Cancelled by you',
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));

    await tx.insert(auditLog).values({
      userId,
      action: 'campaign.cancel',
      entityType: 'campaign',
      entityId: campaignId,
      metadata: { dropped: dropped.length },
    });

    revalidatePath(`/dashboard/campaigns/${campaignId}`);
    revalidatePath('/dashboard');
    return {
      ok: true,
      message: `Cancelled. ${dropped.length} queued ${dropped.length === 1 ? 'message' : 'messages'} dropped.`,
    };
  });
}

/** Options for the campaign form. */
export async function loadCampaignOptions() {
  return queryAsUser(async (tx, userId) => {
    const [sessions, lists, messages] = await Promise.all([
      tx
        .select({
          id: waSessions.id,
          label: waSessions.label,
          phoneE164: waSessions.phoneE164,
          status: waSessions.status,
          accountType: waSessions.accountType,
        })
        .from(waSessions)
        .where(and(eq(waSessions.userId, userId), isNull(waSessions.deletedAt))),

      tx
        .select({
          id: contactLists.id,
          name: contactLists.name,
          rowsImported: contactLists.rowsImported,
          // How many of this list have never been messaged — the number that
          // actually determines how long the campaign will take.
          unmessaged: sql<number>`(
            select count(*)::int from ${contacts} c
             where c.user_id = ${userId}
               and c.list_id = ${contactLists.id}
               and c.last_messaged_at is null
          )`,
        })
        .from(contactLists)
        .where(and(eq(contactLists.userId, userId), isNull(contactLists.deletedAt))),

      tx
        .select({
          id: templates.id,
          name: templates.name,
          variants: sql<number>`(
            select count(*)::int from ${templateVariants} v
             where v.template_id = ${templates.id}
               and v.weight > 0
               and length(trim(v.body)) > 0
          )`,
        })
        .from(templates)
        .where(and(eq(templates.userId, userId), isNull(templates.deletedAt))),
    ]);

    return { sessions, lists, messages };
  });
}

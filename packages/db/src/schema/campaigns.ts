import {
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { waSessions } from './accounts';
import { contactLists, contacts } from './contacts';
import { templates, templateVariants } from './templates';
import { campaignStatusEnum, skipReasonEnum, targetStatusEnum } from './enums';

/** One outreach run: a list, a template and a linked number. */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    status: campaignStatusEnum('status').notNull().default('draft'),

    sessionId: uuid('session_id')
      .notNull()
      .references(() => waSessions.id, { onDelete: 'restrict' }),
    listId: uuid('list_id')
      .notNull()
      .references(() => contactLists.id, { onDelete: 'restrict' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'restrict' }),

    /** Optional per-campaign override of the account's daily ceiling. */
    dailyCapOverride: integer('daily_cap_override'),

    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Set by the governor when a throttle signal forces a hold. */
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pauseReason: text('pause_reason'),

    // Running totals, maintained as targets resolve.
    totalTargets: integer('total_targets').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    replyCount: integer('reply_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('campaigns_user_idx').on(t.userId),
    index('campaigns_status_idx').on(t.status),
  ],
);

/**
 * The work queue. One row per (campaign, contact), claimed by the worker with
 * `FOR UPDATE SKIP LOCKED` so several workers can drain a campaign without
 * ever sending the same person two messages.
 */
export const campaignTargets = pgTable(
  'campaign_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),

    status: targetStatusEnum('status').notNull().default('pending'),
    /** Only set when status = 'skipped'; shown in the campaign report. */
    skipReason: skipReasonEnum('skip_reason'),

    variantId: uuid('variant_id').references(() => templateVariants.id, {
      onDelete: 'set null',
    }),
    /** Exactly what was sent, for the audit trail and the UI transcript. */
    renderedBody: text('rendered_body'),

    attempts: smallint('attempts').notNull().default(0),
    lastError: text('last_error'),

    /** Set while a worker holds the row, so a crashed claim can be reaped. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** WhatsApp's own message id, used to correlate delivery receipts. */
    waMessageId: text('wa_message_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // A contact appears at most once in a campaign.
    uniqueIndex('campaign_targets_campaign_contact_idx').on(t.campaignId, t.contactId),
    // The worker's claim query: pending rows of one campaign, oldest first.
    index('campaign_targets_claim_idx').on(t.campaignId, t.status, t.createdAt),
    index('campaign_targets_user_idx').on(t.userId),
  ],
);

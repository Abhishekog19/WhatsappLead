import {
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { waSessions } from './accounts';
import { campaigns } from './campaigns';
import { contacts } from './contacts';
import {
  messageDirectionEnum,
  messageEventTypeEnum,
  throttleSignalEnum,
} from './enums';

/**
 * The rolling-window ledger — the single source of truth for "how much of my
 * quota have I used?".
 *
 * One row per NEW contact first messaged from a given number. The budget
 * check is:
 *
 *   select count(*) from new_contact_sends
 *    where session_id = $1 and sent_at > now() - interval '24 hours'
 *
 * That is why the window truly rolls: nothing resets at midnight, rows simply
 * age out of the predicate. Follow-ups into an existing thread are not
 * recorded here and so never consume budget.
 *
 * Rows older than the window are kept for a while because the tier promotion
 * rules need utilisation history, then pruned by a maintenance job.
 */
export const newContactSends = pgTable(
  'new_contact_sends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => waSessions.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, {
      onDelete: 'set null',
    }),

    /** Kept even if the contact row is deleted, so the count stays honest. */
    phoneE164: text('phone_e164').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Drives the hot-path budget count.
    index('new_contact_sends_session_sent_idx').on(t.sessionId, t.sentAt),
    index('new_contact_sends_user_idx').on(t.userId),
  ],
);

/**
 * Every limit signal WhatsApp gave us, and what the governor did about it.
 *
 * Retained permanently: this is the evidence trail for why an account sits at
 * tier 1, and the input to the "clean days" promotion rule.
 */
export const throttleEvents = pgTable(
  'throttle_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => waSessions.id, { onDelete: 'cascade' }),

    signal: throttleSignalEnum('signal').notNull(),
    /** Raw payload from the engine, for diagnosing signals we do not yet map. */
    raw: jsonb('raw'),

    tierBefore: smallint('tier_before'),
    tierAfter: smallint('tier_after'),
    pausedUntil: timestamp('paused_until', { withTimezone: true }),
    /** Whether the user was notified; drives the dashboard alert banner. */
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('throttle_events_session_idx').on(t.sessionId, t.occurredAt),
    index('throttle_events_user_idx').on(t.userId),
  ],
);

/**
 * Delivery lifecycle and inbound replies.
 *
 * Replies matter beyond the inbox: reply rate is a promotion condition for
 * the top tier, and a strong proxy for whether outreach is landing well.
 */
export const messageEvents = pgTable(
  'message_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => waSessions.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, {
      onDelete: 'set null',
    }),

    direction: messageDirectionEnum('direction').notNull(),
    type: messageEventTypeEnum('type').notNull(),
    waMessageId: text('wa_message_id'),
    /** Inbound body, truncated; outbound lives on campaign_targets. */
    body: text('body'),
    error: text('error'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('message_events_session_idx').on(t.sessionId, t.occurredAt),
    index('message_events_campaign_idx').on(t.campaignId),
    index('message_events_wa_message_idx').on(t.waMessageId),
    index('message_events_user_idx').on(t.userId),
  ],
);

/**
 * Security-relevant actions: linking and unlinking numbers, changing caps,
 * exporting contacts, deleting data. Append-only; nothing in the app updates
 * or deletes a row here.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    metadata: jsonb('metadata'),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('audit_log_user_idx').on(t.userId, t.occurredAt)],
);

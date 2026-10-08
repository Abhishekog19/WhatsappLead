import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { accountTypeEnum, dedupeModeEnum, waEngineEnum, waSessionStatusEnum } from './enums';

/**
 * Per-user preferences. Exactly one row per user, created on first login.
 *
 * Note what is NOT here: the new-contact tier and warm-up state. Those belong
 * to a WhatsApp number, not to a person — a user may link two numbers with
 * very different reputations.
 */
export const settings = pgTable('settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),

  // --- Deduplication -------------------------------------------------------
  dedupeMode: dedupeModeEnum('dedupe_mode').notNull().default('never_repeat'),
  /** Only meaningful when dedupeMode = 'cooldown'. */
  cooldownDays: integer('cooldown_days').notNull().default(90),

  // --- Volume --------------------------------------------------------------
  /**
   * The user's own ceiling, if they want to send less than their earned tier.
   * NULL means "use whatever the tier allows".
   */
  newContactCap24h: integer('new_contact_cap_24h'),
  warmupEnabled: boolean('warmup_enabled').notNull().default(true),

  // --- Pacing (defaults mirror DEFAULT_PACING in @wa/core) ------------------
  minDelayMs: integer('min_delay_ms').notNull().default(25_000),
  maxDelayMs: integer('max_delay_ms').notNull().default(55_000),
  batchSize: integer('batch_size').notNull().default(15),
  minBatchPauseMs: integer('min_batch_pause_ms').notNull().default(45 * 60 * 1_000),
  maxBatchPauseMs: integer('max_batch_pause_ms').notNull().default(90 * 60 * 1_000),
  simulateTyping: boolean('simulate_typing').notNull().default(true),

  // --- Send window ---------------------------------------------------------
  sendWindowStartHour: smallint('send_window_start_hour').notNull().default(10),
  sendWindowEndHour: smallint('send_window_end_hour').notNull().default(19),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  /** Skip Saturdays and Sundays. */
  skipWeekends: boolean('skip_weekends').notNull().default(false),

  // --- Import --------------------------------------------------------------
  /** ISO-3166 alpha-2, used when a spreadsheet number has no country code. */
  defaultCountry: text('default_country').notNull().default('IN'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A linked WhatsApp number.
 *
 * `credsEncrypted` holds the engine's auth state as an AES-256-GCM blob (see
 * @wa/core/crypto). It is equivalent to full access to the account, which is
 * why it never leaves the server and is never logged.
 */
export const waSessions = pgTable(
  'wa_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    label: text('label').notNull().default('My WhatsApp'),
    phoneE164: text('phone_e164'),
    accountType: accountTypeEnum('account_type').notNull().default('personal'),
    engine: waEngineEnum('engine').notNull().default('baileys'),
    status: waSessionStatusEnum('status').notNull().default('pending'),

    credsEncrypted: text('creds_encrypted'),

    // --- Linking handshake (transient) -------------------------------------
    pairingCode: text('pairing_code'),
    pairingCodeExpiresAt: timestamp('pairing_code_expires_at', { withTimezone: true }),
    qrPayload: text('qr_payload'),
    qrExpiresAt: timestamp('qr_expires_at', { withTimezone: true }),

    // --- Reputation --------------------------------------------------------
    /** Drives the warm-up ramp; set when the link first succeeds. */
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    tier: smallint('tier').notNull().default(1),
    tierUpdatedAt: timestamp('tier_updated_at', { withTimezone: true }),
    /** Consecutive days with no throttle signal; resets to 0 on any signal. */
    cleanDays: integer('clean_days').notNull().default(0),
    /** Multiplied into every inter-message delay after a warning. */
    delayMultiplier: real('delay_multiplier').notNull().default(1),
    /** Hard hold until this moment — set by capped_475 / shadow_463. */
    throttledUntil: timestamp('throttled_until', { withTimezone: true }),

    lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('wa_sessions_user_idx').on(t.userId),
    index('wa_sessions_status_idx').on(t.status),
    // The same number must not be linked twice by one user. Partial so that
    // unlinked (phone still NULL) and soft-deleted rows do not collide.
    uniqueIndex('wa_sessions_user_phone_idx')
      .on(t.userId, t.phoneE164)
      .where(sql`phone_e164 is not null and deleted_at is null`),
  ],
);

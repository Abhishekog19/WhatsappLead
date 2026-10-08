import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Every enum the application uses, in one place.
 *
 * Postgres enums are additive-only — a value can be appended in a migration
 * but not removed or reordered — so each list is written in the order it will
 * keep forever. Anything expected to churn is a plain text column instead.
 */

export const accountTypeEnum = pgEnum('account_type', ['personal', 'business']);

export const waEngineEnum = pgEnum('wa_engine', ['baileys', 'wwebjs']);

export const waSessionStatusEnum = pgEnum('wa_session_status', [
  /** Row created, nothing linked yet. */
  'pending',
  /** Pairing code / QR issued, waiting for the phone to confirm. */
  'pairing',
  'connected',
  /** Link intact, socket down — the worker will reconnect. */
  'disconnected',
  /** User unlinked from their phone; credentials are dead. */
  'logged_out',
  /** WhatsApp signalled a limit. Still linked, deliberately holding. */
  'throttled',
  'banned',
]);

/**
 * How aggressively a user wants to avoid contacting the same number twice.
 * Scoped entirely to the user — one account's history never constrains
 * another's.
 */
export const dedupeModeEnum = pgEnum('dedupe_mode', [
  /** Never message a number this account has already messaged. */
  'never_repeat',
  /** Allow a repeat once `cooldown_days` have passed. */
  'cooldown',
  /** Only the explicit suppression list blocks a send. */
  'off',
]);

export const throttleSignalEnum = pgEnum('throttle_signal', [
  'first_warning',
  'second_warning',
  'capped_475',
  'shadow_463',
]);

export const campaignStatusEnum = pgEnum('campaign_status', [
  'draft',
  'scheduled',
  'running',
  /** Paused by the user, or automatically by the safety governor. */
  'paused',
  'completed',
  'cancelled',
  'failed',
]);

export const targetStatusEnum = pgEnum('target_status', [
  'pending',
  'sending',
  'sent',
  'failed',
  'skipped',
]);

export const skipReasonEnum = pgEnum('skip_reason', [
  'duplicate',
  'suppressed',
  'invalid_number',
  'not_on_whatsapp',
  'cooldown',
  'cap_reached',
  'outside_window',
]);

export const messageDirectionEnum = pgEnum('message_direction', ['out', 'in']);

export const messageEventTypeEnum = pgEnum('message_event_type', [
  'sent',
  'delivered',
  'read',
  'failed',
  'reply',
]);

export const suppressionReasonEnum = pgEnum('suppression_reason', [
  'manual',
  'opt_out',
  'invalid_number',
  'not_on_whatsapp',
  'reported',
]);

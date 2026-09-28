import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { suppressionReasonEnum } from './enums';

/** One uploaded spreadsheet. */
export const contactLists = pgTable(
  'contact_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    sourceFilename: text('source_filename'),
    /** Header row as uploaded — drives the template's placeholder hints. */
    columns: jsonb('columns').$type<string[]>().notNull().default(sql`'[]'::jsonb`),

    // Import outcome, kept so the user can see why 400 rows became 362.
    rowsTotal: integer('rows_total').notNull().default(0),
    rowsImported: integer('rows_imported').notNull().default(0),
    rowsInvalid: integer('rows_invalid').notNull().default(0),
    rowsDuplicate: integer('rows_duplicate').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('contact_lists_user_idx').on(t.userId)],
);

/**
 * A person, unique per user by normalised phone number.
 *
 * The uniqueness is deliberately scoped to `user_id`: two users may both hold
 * the same lead, and neither one's history may constrain the other's sending.
 * Re-uploading a spreadsheet updates the existing row rather than creating a
 * second copy, which is what makes per-account dedupe reliable.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    listId: uuid('list_id').references(() => contactLists.id, { onDelete: 'set null' }),

    phoneE164: text('phone_e164').notNull(),
    name: text('name'),
    /** Every other spreadsheet column, available to templates as {{Column}}. */
    fields: jsonb('fields').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),

    /** Result of the WhatsApp registration check; NULL = not checked yet. */
    onWhatsapp: text('on_whatsapp').$type<'yes' | 'no' | null>(),
    onWhatsappCheckedAt: timestamp('on_whatsapp_checked_at', { withTimezone: true }),

    /**
     * Denormalised from new_contact_sends. Dedupe is a per-row read on the hot
     * path; a join per candidate would dominate the send loop.
     */
    lastMessagedAt: timestamp('last_messaged_at', { withTimezone: true }),
    messageCount: integer('message_count').notNull().default(0),
    lastRepliedAt: timestamp('last_replied_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('contacts_user_phone_idx').on(t.userId, t.phoneE164),
    index('contacts_list_idx').on(t.listId),
    index('contacts_user_last_messaged_idx').on(t.userId, t.lastMessagedAt),
  ],
);

/**
 * Do-not-contact list. Checked before every send, regardless of dedupe mode —
 * this is the one rule a user cannot switch off, because it is how opt-outs
 * are honoured.
 */
export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    phoneE164: text('phone_e164').notNull(),
    reason: suppressionReasonEnum('reason').notNull().default('manual'),
    note: text('note'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('suppressions_user_phone_idx').on(t.userId, t.phoneE164)],
);

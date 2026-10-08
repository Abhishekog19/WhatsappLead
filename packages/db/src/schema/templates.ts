import {
  boolean,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';

/**
 * A named message with one or more variants.
 *
 * Variants are separate rows rather than a JSON array so that per-variant
 * stats (sends, replies) can be aggregated, which is what makes "variant B
 * gets twice the replies" visible to the user.
 */
export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('templates_user_idx').on(t.userId)],
);

export const templateVariants = pgTable(
  'template_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    /** Denormalised so row-level security can filter without a join. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    label: text('label'),
    body: text('body').notNull(),
    /** Relative selection weight; 0 retires a variant without deleting it. */
    weight: smallint('weight').notNull().default(1),
    position: smallint('position').notNull().default(0),

    sentCount: integer('sent_count').notNull().default(0),
    replyCount: integer('reply_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('template_variants_template_idx').on(t.templateId),
    index('template_variants_user_idx').on(t.userId),
  ],
);

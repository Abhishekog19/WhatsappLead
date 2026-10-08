import { relations } from 'drizzle-orm';
import { users } from './auth';
import { settings, waSessions } from './accounts';
import { contactLists, contacts, suppressions } from './contacts';
import { templates, templateVariants } from './templates';
import { campaigns, campaignTargets } from './campaigns';
import { messageEvents, newContactSends, throttleEvents } from './events';

/**
 * Relations for the query builder (`db.query.*.findMany({ with: ... })`).
 * Declarative only — the foreign keys themselves live on the tables.
 */

export const usersRelations = relations(users, ({ one, many }) => ({
  settings: one(settings, { fields: [users.id], references: [settings.userId] }),
  waSessions: many(waSessions),
  contactLists: many(contactLists),
  contacts: many(contacts),
  suppressions: many(suppressions),
  templates: many(templates),
  campaigns: many(campaigns),
}));

export const settingsRelations = relations(settings, ({ one }) => ({
  user: one(users, { fields: [settings.userId], references: [users.id] }),
}));

export const waSessionsRelations = relations(waSessions, ({ one, many }) => ({
  user: one(users, { fields: [waSessions.userId], references: [users.id] }),
  campaigns: many(campaigns),
  newContactSends: many(newContactSends),
  throttleEvents: many(throttleEvents),
  messageEvents: many(messageEvents),
}));

export const contactListsRelations = relations(contactLists, ({ one, many }) => ({
  user: one(users, { fields: [contactLists.userId], references: [users.id] }),
  contacts: many(contacts),
  campaigns: many(campaigns),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  user: one(users, { fields: [contacts.userId], references: [users.id] }),
  list: one(contactLists, {
    fields: [contacts.listId],
    references: [contactLists.id],
  }),
  targets: many(campaignTargets),
}));

export const suppressionsRelations = relations(suppressions, ({ one }) => ({
  user: one(users, { fields: [suppressions.userId], references: [users.id] }),
}));

export const templatesRelations = relations(templates, ({ one, many }) => ({
  user: one(users, { fields: [templates.userId], references: [users.id] }),
  variants: many(templateVariants),
  campaigns: many(campaigns),
}));

export const templateVariantsRelations = relations(templateVariants, ({ one }) => ({
  template: one(templates, {
    fields: [templateVariants.templateId],
    references: [templates.id],
  }),
  user: one(users, { fields: [templateVariants.userId], references: [users.id] }),
}));

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  user: one(users, { fields: [campaigns.userId], references: [users.id] }),
  session: one(waSessions, {
    fields: [campaigns.sessionId],
    references: [waSessions.id],
  }),
  list: one(contactLists, {
    fields: [campaigns.listId],
    references: [contactLists.id],
  }),
  template: one(templates, {
    fields: [campaigns.templateId],
    references: [templates.id],
  }),
  targets: many(campaignTargets),
}));

export const campaignTargetsRelations = relations(campaignTargets, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignTargets.campaignId],
    references: [campaigns.id],
  }),
  contact: one(contacts, {
    fields: [campaignTargets.contactId],
    references: [contacts.id],
  }),
  variant: one(templateVariants, {
    fields: [campaignTargets.variantId],
    references: [templateVariants.id],
  }),
}));

export const newContactSendsRelations = relations(newContactSends, ({ one }) => ({
  session: one(waSessions, {
    fields: [newContactSends.sessionId],
    references: [waSessions.id],
  }),
  contact: one(contacts, {
    fields: [newContactSends.contactId],
    references: [contacts.id],
  }),
}));

export const throttleEventsRelations = relations(throttleEvents, ({ one }) => ({
  session: one(waSessions, {
    fields: [throttleEvents.sessionId],
    references: [waSessions.id],
  }),
}));

export const messageEventsRelations = relations(messageEvents, ({ one }) => ({
  session: one(waSessions, {
    fields: [messageEvents.sessionId],
    references: [waSessions.id],
  }),
  contact: one(contacts, {
    fields: [messageEvents.contactId],
    references: [contacts.id],
  }),
  campaign: one(campaigns, {
    fields: [messageEvents.campaignId],
    references: [campaigns.id],
  }),
}));

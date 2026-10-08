'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  MAX_MESSAGE_LENGTH,
  extractPlaceholders,
  renderTemplate,
  validateTemplate,
  type TemplateProblem,
} from '@wa/core';
import {
  and,
  asc,
  auditLog,
  contactLists,
  contacts,
  desc,
  eq,
  isNull,
  sql,
  templates,
  templateVariants,
} from '@wa/db';
import { queryAsUser } from '@/server/session';

/**
 * Template editing.
 *
 * A template is a name plus one or more variants. Variants are separate rows
 * rather than a JSON array so per-variant reply counts can be aggregated —
 * which is what makes "version B gets twice the replies" visible instead of
 * guesswork.
 */

export interface TemplateResult {
  ok: boolean;
  message: string;
  templateId?: string;
  problems?: TemplateProblem[];
}

const MAX_VARIANTS = 5;

const schema = z.object({
  name: z.string().trim().min(1, 'Name this message.').max(80),
  variants: z
    .array(
      z.object({
        id: z.string().uuid().nullable(),
        label: z.string().trim().max(40).nullable(),
        body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
      }),
    )
    .min(1, 'Write at least one version.')
    .max(MAX_VARIANTS),
});

export async function saveTemplate(
  _prev: TemplateResult | null,
  formData: FormData,
): Promise<TemplateResult> {
  const templateId = (formData.get('templateId') as string | null) || null;

  const raw = {
    name: formData.get('name'),
    variants: JSON.parse((formData.get('variants') as string) || '[]'),
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Check the message.',
    };
  }

  const { name, variants } = parsed.data;

  // Validation needs the columns the user actually has, so a placeholder that
  // will render blank is flagged before a campaign goes out rather than after.
  const columns = await queryAsUser(async (tx, userId) => {
    const rows = await tx
      .select({ columns: contactLists.columns })
      .from(contactLists)
      .where(and(eq(contactLists.userId, userId), isNull(contactLists.deletedAt)));
    const all = new Set<string>(['name', 'phone']);
    for (const row of rows) for (const c of row.columns) all.add(c);
    return [...all];
  });

  const problems = variants.flatMap((v) => validateTemplate(v.body, columns));
  if (problems.some((p) => p.level === 'error')) {
    return { ok: false, message: 'Fix the errors below before saving.', problems };
  }

  const saved = await queryAsUser(async (tx, userId) => {
    let id = templateId;

    if (id) {
      const owned = await tx
        .update(templates)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(templates.id, id), eq(templates.userId, userId)))
        .returning({ id: templates.id });
      if (!owned[0]) return null;
    } else {
      const created = await tx
        .insert(templates)
        .values({ userId, name })
        .returning({ id: templates.id });
      id = created[0]?.id ?? null;
      if (!id) return null;
    }

    const keptIds: string[] = [];
    for (const [index, variant] of variants.entries()) {
      if (variant.id) {
        const updated = await tx
          .update(templateVariants)
          .set({
            label: variant.label,
            body: variant.body,
            position: index,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(templateVariants.id, variant.id),
              eq(templateVariants.userId, userId),
              eq(templateVariants.templateId, id),
            ),
          )
          .returning({ id: templateVariants.id });
        if (updated[0]) {
          keptIds.push(updated[0].id);
          continue;
        }
        // Fall through: the id did not belong to this template, so treat it as
        // a new variant rather than silently dropping the user's text.
      }

      const created = await tx
        .insert(templateVariants)
        .values({
          templateId: id,
          userId,
          label: variant.label,
          body: variant.body,
          position: index,
        })
        .returning({ id: templateVariants.id });
      if (created[0]) keptIds.push(created[0].id);
    }

    // Retire removed variants rather than deleting them: campaign_targets
    // reference the variant that was sent, and the send counts are the only
    // record of how each version performed.
    await tx
      .update(templateVariants)
      .set({ weight: 0, updatedAt: new Date() })
      .where(
        and(
          eq(templateVariants.templateId, id),
          eq(templateVariants.userId, userId),
          keptIds.length > 0
            ? sql`${templateVariants.id} not in ${keptIds}`
            : sql`true`,
        ),
      );

    // Re-activate anything the user brought back.
    if (keptIds.length > 0) {
      await tx
        .update(templateVariants)
        .set({ weight: 1, updatedAt: new Date() })
        .where(
          and(
            eq(templateVariants.templateId, id),
            sql`${templateVariants.id} in ${keptIds}`,
            eq(templateVariants.weight, 0),
          ),
        );
    }

    await tx.insert(auditLog).values({
      userId,
      action: templateId ? 'template.update' : 'template.create',
      entityType: 'template',
      entityId: id,
      metadata: { variants: variants.length },
    });

    return id;
  });

  if (!saved) return { ok: false, message: 'Message not found.' };

  revalidatePath('/dashboard/templates');
  revalidatePath(`/dashboard/templates/${saved}`);

  return {
    ok: true,
    message: 'Message saved.',
    templateId: saved,
    problems: problems.filter((p) => p.level === 'warning'),
  };
}

export async function deleteTemplate(
  templateId: string,
): Promise<{ ok: boolean; message: string }> {
  return queryAsUser(async (tx, userId) => {
    const inUse = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sql`campaigns`)
      .where(
        sql`user_id = ${userId} and template_id = ${templateId} and status in ('running','scheduled','paused')`,
      );

    if (Number(inUse[0]?.n ?? 0) > 0) {
      return { ok: false, message: 'A campaign is still using this message.' };
    }

    const result = await tx
      .update(templates)
      .set({ deletedAt: new Date() })
      .where(and(eq(templates.id, templateId), eq(templates.userId, userId)))
      .returning({ id: templates.id });

    if (!result[0]) return { ok: false, message: 'Message not found.' };

    revalidatePath('/dashboard/templates');
    return { ok: true, message: 'Message deleted.' };
  });
}

/**
 * Renders a template against a real contact.
 *
 * Deliberately uses live data rather than made-up sample values: a preview
 * built from "John Smith" and "Acme Ltd" hides exactly the problems that
 * matter — the business name that is 90 characters long, or the rating column
 * that is empty for a third of the list.
 */
export interface PreviewRender {
  text: string;
  missing: string[];
  contactName: string | null;
  length: number;
  usedPlaceholders: string[];
}

export async function previewTemplate(
  body: string,
  options: { contactId?: string | null } = {},
): Promise<PreviewRender | null> {
  if (!body.trim()) return null;

  return queryAsUser(async (tx, userId) => {
    const rows = await tx
      .select({
        name: contacts.name,
        phoneE164: contacts.phoneE164,
        fields: contacts.fields,
      })
      .from(contacts)
      .where(
        options.contactId
          ? and(eq(contacts.userId, userId), eq(contacts.id, options.contactId))
          : eq(contacts.userId, userId),
      )
      // Newest import first, so the preview reflects the list the user is
      // about to send to.
      .orderBy(desc(contacts.createdAt))
      .limit(1);

    const contact = rows[0];
    const vars = contact
      ? { ...contact.fields, name: contact.name ?? '', phone: contact.phoneE164 }
      : {};

    const rendered = renderTemplate(body, vars);

    return {
      text: rendered.text,
      missing: rendered.missing,
      contactName: contact?.name ?? null,
      length: rendered.text.length,
      usedPlaceholders: extractPlaceholders(body),
    };
  });
}

export async function createTemplateAndGo(): Promise<void> {
  const id = await queryAsUser(async (tx, userId) => {
    const created = await tx
      .insert(templates)
      .values({ userId, name: 'New message' })
      .returning({ id: templates.id });

    const templateId = created[0]?.id;
    if (!templateId) return null;

    await tx.insert(templateVariants).values({
      templateId,
      userId,
      body: '',
      position: 0,
    });

    return templateId;
  });

  if (id) redirect(`/dashboard/templates/${id}`);
}

/** Variants in display order, for the editor. */
export async function loadTemplate(templateId: string) {
  return queryAsUser(async (tx, userId) => {
    const rows = await tx
      .select({
        id: templates.id,
        name: templates.name,
      })
      .from(templates)
      .where(
        and(
          eq(templates.id, templateId),
          eq(templates.userId, userId),
          isNull(templates.deletedAt),
        ),
      )
      .limit(1);

    const template = rows[0];
    if (!template) return null;

    const variants = await tx
      .select({
        id: templateVariants.id,
        label: templateVariants.label,
        body: templateVariants.body,
        weight: templateVariants.weight,
        sentCount: templateVariants.sentCount,
        replyCount: templateVariants.replyCount,
      })
      .from(templateVariants)
      .where(eq(templateVariants.templateId, templateId))
      .orderBy(asc(templateVariants.position));

    return { template, variants };
  });
}

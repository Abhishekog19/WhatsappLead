'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { auditLog, eq, settings } from '@wa/db';
import { queryAsUser } from '@/server/session';

/**
 * Settings mutations.
 *
 * Everything here changes how fast the user's number sends, so the bounds are
 * enforced server-side rather than trusted from the form. The upper bounds are
 * not arbitrary: a 5-second gap between messages is a bot signature, and a cap
 * above the platform ceiling would be silently clamped anyway.
 */

const schema = z
  .object({
    dedupeMode: z.enum(['never_repeat', 'cooldown', 'off']),
    cooldownDays: z.coerce.number().int().min(1).max(3650),
    newContactCap24h: z
      .union([z.coerce.number().int().min(1).max(500), z.literal('')])
      .transform((v) => (v === '' ? null : v)),
    warmupEnabled: z.coerce.boolean(),
    minDelayMs: z.coerce.number().int().min(10_000).max(600_000),
    maxDelayMs: z.coerce.number().int().min(10_000).max(1_800_000),
    batchSize: z.coerce.number().int().min(1).max(100),
    sendWindowStartHour: z.coerce.number().int().min(0).max(23),
    sendWindowEndHour: z.coerce.number().int().min(1).max(24),
    skipWeekends: z.coerce.boolean(),
    timezone: z.string().min(1).max(64),
    defaultCountry: z.string().length(2).toUpperCase(),
  })
  .refine((v) => v.maxDelayMs >= v.minDelayMs, {
    path: ['maxDelayMs'],
    message: 'Maximum delay must be at least the minimum delay.',
  })
  .refine((v) => v.sendWindowEndHour > v.sendWindowStartHour, {
    path: ['sendWindowEndHour'],
    message: 'The send window must end after it starts.',
  });

export interface SaveResult {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
}

export async function saveSettings(
  _prev: SaveResult | null,
  formData: FormData,
): Promise<SaveResult> {
  const raw = {
    dedupeMode: formData.get('dedupeMode'),
    cooldownDays: formData.get('cooldownDays'),
    newContactCap24h: formData.get('newContactCap24h') ?? '',
    // Unchecked checkboxes are absent from FormData entirely.
    warmupEnabled: formData.get('warmupEnabled') === 'on',
    minDelayMs: Number(formData.get('minDelaySeconds') ?? 0) * 1000,
    maxDelayMs: Number(formData.get('maxDelaySeconds') ?? 0) * 1000,
    batchSize: formData.get('batchSize'),
    sendWindowStartHour: formData.get('sendWindowStartHour'),
    sendWindowEndHour: formData.get('sendWindowEndHour'),
    skipWeekends: formData.get('skipWeekends') === 'on',
    timezone: formData.get('timezone'),
    defaultCountry: formData.get('defaultCountry'),
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: 'Some values need fixing.', fieldErrors };
  }

  const v = parsed.data;

  await queryAsUser(async (tx, userId) => {
    await tx
      .update(settings)
      .set({ ...v, updatedAt: new Date() })
      .where(eq(settings.userId, userId));

    await tx.insert(auditLog).values({
      userId,
      action: 'settings.update',
      entityType: 'settings',
      entityId: userId,
      // Only the safety-relevant fields are recorded; there is no need to keep
      // a history of timezone changes.
      metadata: {
        dedupeMode: v.dedupeMode,
        newContactCap24h: v.newContactCap24h,
        warmupEnabled: v.warmupEnabled,
        minDelayMs: v.minDelayMs,
        maxDelayMs: v.maxDelayMs,
      },
    });
  });

  revalidatePath('/dashboard/settings');
  return { ok: true, message: 'Settings saved.' };
}

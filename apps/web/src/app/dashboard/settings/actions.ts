'use server';

import { revalidatePath } from 'next/cache';
import { auditLog, eq, settings } from '@wa/db';
import { queryAsUser } from '@/server/session';
import { parseSettingsForm } from './schema';

/**
 * Settings mutations.
 *
 * The validation lives in ./schema.ts so it can be tested on its own; this is
 * only the part that needs a session and a database.
 */

export interface SaveResult {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
}

export async function saveSettings(
  _prev: SaveResult | null,
  formData: FormData,
): Promise<SaveResult> {
  const parsed = parseSettingsForm(formData);
  if (!parsed.ok) {
    return { ok: false, message: parsed.message, fieldErrors: parsed.fieldErrors };
  }

  const v = parsed.value;

  const saved = await queryAsUser(async (tx, userId) => {
    // returning() rather than a bare update: a zero-row update means the
    // settings row is missing, and reporting "saved" in that case is how a
    // form appears to silently revert.
    const rows = await tx
      .update(settings)
      .set({ ...v, updatedAt: new Date() })
      .where(eq(settings.userId, userId))
      .returning({
        startHour: settings.sendWindowStartHour,
        endHour: settings.sendWindowEndHour,
      });

    if (!rows[0]) return null;

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
        sendWindowStartHour: v.sendWindowStartHour,
        sendWindowEndHour: v.sendWindowEndHour,
      },
    });

    return rows[0];
  });

  if (!saved) {
    return {
      ok: false,
      message: 'Your settings row is missing. Reload the page and try again.',
    };
  }

  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard');

  // Echo the hours back. The form has no way to tell a successful save from a
  // rejected one otherwise, which is exactly how this looked like a revert.
  return {
    ok: true,
    message: `Saved. Sending between ${formatHour(saved.startHour)} and ${formatHour(saved.endHour)}.`,
  };
}

function formatHour(h: number): string {
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  if (h === 24) return 'midnight';
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

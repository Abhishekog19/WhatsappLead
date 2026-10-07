'use server';

import { revalidatePath } from 'next/cache';
import {
  and,
  auditLog,
  campaignTargets,
  contacts,
  eq,
  suppressions,
} from '@wa/db';
import { maskPhone } from '@wa/core';
import { queryAsUser } from '@/server/session';

/**
 * Per-contact actions.
 *
 * Suppression is deliberately easy to reach: a user who realises they should
 * not be messaging someone needs one tap, not a settings page.
 */

export interface ContactActionResult {
  ok: boolean;
  message: string;
}

export async function suppressContact(
  contactId: string,
  note?: string,
): Promise<ContactActionResult> {
  return queryAsUser(async (tx, userId) => {
    const rows = await tx
      .select({ phone: contacts.phoneE164 })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
      .limit(1);

    const phone = rows[0]?.phone;
    if (!phone) return { ok: false, message: 'Contact not found.' };

    await tx
      .insert(suppressions)
      .values({
        userId,
        phoneE164: phone,
        reason: 'manual',
        note: note?.slice(0, 200) ?? null,
      })
      .onConflictDoNothing();

    // Take them out of anything still queued, so the decision applies now
    // rather than after the current campaign drains.
    await tx
      .update(campaignTargets)
      .set({ status: 'skipped', skipReason: 'suppressed' })
      .where(
        and(
          eq(campaignTargets.userId, userId),
          eq(campaignTargets.contactId, contactId),
          eq(campaignTargets.status, 'pending'),
        ),
      );

    await tx.insert(auditLog).values({
      userId,
      action: 'suppression.create',
      entityType: 'contact',
      entityId: contactId,
      metadata: { phone: maskPhone(phone), reason: 'manual' },
    });

    revalidatePath(`/dashboard/contacts/${contactId}`);
    revalidatePath('/dashboard/contacts');
    return { ok: true, message: 'This number will not be messaged again.' };
  });
}

export async function unsuppressContact(
  contactId: string,
): Promise<ContactActionResult> {
  return queryAsUser(async (tx, userId) => {
    const rows = await tx
      .select({ phone: contacts.phoneE164 })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
      .limit(1);

    const phone = rows[0]?.phone;
    if (!phone) return { ok: false, message: 'Contact not found.' };

    const existing = await tx
      .select({ reason: suppressions.reason })
      .from(suppressions)
      .where(and(eq(suppressions.userId, userId), eq(suppressions.phoneE164, phone)))
      .limit(1);

    // An opt-out is the recipient's decision, not the sender's. Letting it be
    // undone here would make the one rule that cannot be configured away
    // configurable after all.
    if (existing[0]?.reason === 'opt_out') {
      return {
        ok: false,
        message:
          'This person asked to stop receiving messages, so they cannot be re-enabled.',
      };
    }

    await tx
      .delete(suppressions)
      .where(and(eq(suppressions.userId, userId), eq(suppressions.phoneE164, phone)));

    await tx.insert(auditLog).values({
      userId,
      action: 'suppression.remove',
      entityType: 'contact',
      entityId: contactId,
      metadata: { phone: maskPhone(phone) },
    });

    revalidatePath(`/dashboard/contacts/${contactId}`);
    revalidatePath('/dashboard/contacts');
    return { ok: true, message: 'This number can be messaged again.' };
  });
}

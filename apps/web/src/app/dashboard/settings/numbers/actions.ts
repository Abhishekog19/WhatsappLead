'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { and, auditLog, eq, isNull, sql, waSessions } from '@wa/db';
import { maskPhone, normalizePhone } from '@wa/core';
import { queryAsUser } from '@/server/session';

/**
 * Linking a WhatsApp number.
 *
 * Note what these actions do NOT do: open a socket. WhatsApp allows one
 * connection per linked device and Next.js may be running several processes,
 * so a socket opened here would fight the worker's and get the number logged
 * out. Instead a row is written, the worker notices it within a few seconds
 * and performs the handshake, and the browser watches the same row.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Set on success so the UI can start watching the right row. */
  sessionId?: string;
  fieldErrors?: Record<string, string>;
}

const addSchema = z.object({
  label: z.string().trim().min(1, 'Give this number a name.').max(60),
  phone: z.string().trim().min(5, 'Enter the number including its country code.'),
  accountType: z.enum(['personal', 'business']),
  defaultCountry: z.string().length(2).toUpperCase(),
});

/** How many numbers one account may link. */
const MAX_SESSIONS_PER_USER = 3;

export async function addNumber(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = addSchema.safeParse({
    label: formData.get('label'),
    phone: formData.get('phone'),
    accountType: formData.get('accountType') ?? 'personal',
    defaultCountry: formData.get('defaultCountry') ?? 'IN',
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: 'Check the details below.', fieldErrors };
  }

  const { label, phone, accountType, defaultCountry } = parsed.data;

  const normalised = normalizePhone(phone, defaultCountry);
  if (!normalised.ok) {
    return {
      ok: false,
      message: 'That does not look like a valid mobile number.',
      fieldErrors: {
        phone:
          normalised.reason === 'invalid'
            ? 'Not a valid number for that country. Include the country code, e.g. +91…'
            : 'Enter a full mobile number, including the country code.',
      },
    };
  }

  const e164 = normalised.e164;

  return queryAsUser(async (tx, userId) => {
    const existing = await tx
      .select({ id: waSessions.id, status: waSessions.status })
      .from(waSessions)
      .where(and(eq(waSessions.userId, userId), isNull(waSessions.deletedAt)));

    if (existing.length >= MAX_SESSIONS_PER_USER) {
      return {
        ok: false,
        message: `You can link up to ${MAX_SESSIONS_PER_USER} numbers. Remove one first.`,
      };
    }

    const sameNumber = await tx
      .select({ id: waSessions.id })
      .from(waSessions)
      .where(
        and(
          eq(waSessions.userId, userId),
          eq(waSessions.phoneE164, e164),
          isNull(waSessions.deletedAt),
        ),
      )
      .limit(1);

    if (sameNumber[0]) {
      return {
        ok: false,
        message: 'That number is already on your account.',
        fieldErrors: { phone: 'Already linked.' },
      };
    }

    const [created] = await tx
      .insert(waSessions)
      .values({
        userId,
        label,
        phoneE164: e164,
        accountType,
        // 'pending' with a phone number and no credentials is precisely the
        // signal the worker's maintain-sessions job looks for.
        status: 'pending',
      })
      .returning({ id: waSessions.id });

    if (!created) return { ok: false, message: 'Could not save the number.' };

    await tx.insert(auditLog).values({
      userId,
      action: 'wa_session.create',
      entityType: 'wa_session',
      entityId: created.id,
      metadata: { phone: maskPhone(e164), accountType },
    });

    revalidatePath('/dashboard/settings/numbers');
    return { ok: true, message: 'Requesting your pairing code…', sessionId: created.id };
  });
}

/**
 * Asks for a fresh pairing code.
 *
 * Resetting the row to 'pending' and clearing the old code is enough: the
 * worker tears down the stale socket and starts a new handshake, because a
 * code only stays valid for the socket that issued it.
 */
export async function retryPairing(sessionId: string): Promise<ActionResult> {
  return queryAsUser(async (tx, userId) => {
    const rows = await tx
      .select({ id: waSessions.id, phone: waSessions.phoneE164 })
      .from(waSessions)
      .where(
        and(
          eq(waSessions.id, sessionId),
          eq(waSessions.userId, userId),
          isNull(waSessions.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row?.phone) return { ok: false, message: 'Number not found.' };

    await tx
      .update(waSessions)
      .set({
        status: 'pending',
        credsEncrypted: null,
        pairingCode: null,
        pairingCodeExpiresAt: null,
        qrPayload: null,
        qrExpiresAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(waSessions.id, sessionId));

    revalidatePath('/dashboard/settings/numbers');
    return { ok: true, message: 'Getting a new code…', sessionId };
  });
}

/**
 * Unlinks a number.
 *
 * Soft-deleted rather than removed, because campaigns reference the session
 * and their history should stay readable. Clearing the credentials is the part
 * that matters: it is what makes the row unusable.
 */
export async function unlinkNumber(sessionId: string): Promise<ActionResult> {
  return queryAsUser(async (tx, userId) => {
    const running = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sql`campaigns`)
      .where(
        sql`user_id = ${userId} and session_id = ${sessionId} and status in ('running','scheduled')`,
      );

    if (Number(running[0]?.n ?? 0) > 0) {
      return {
        ok: false,
        message: 'Stop the campaigns using this number before unlinking it.',
      };
    }

    const result = await tx
      .update(waSessions)
      .set({
        status: 'logged_out',
        credsEncrypted: null,
        pairingCode: null,
        pairingCodeExpiresAt: null,
        qrPayload: null,
        qrExpiresAt: null,
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(waSessions.id, sessionId), eq(waSessions.userId, userId)))
      .returning({ id: waSessions.id });

    if (!result[0]) return { ok: false, message: 'Number not found.' };

    await tx.insert(auditLog).values({
      userId,
      action: 'wa_session.unlink',
      entityType: 'wa_session',
      entityId: sessionId,
    });

    revalidatePath('/dashboard/settings/numbers');
    return { ok: true, message: 'Number unlinked.' };
  });
}

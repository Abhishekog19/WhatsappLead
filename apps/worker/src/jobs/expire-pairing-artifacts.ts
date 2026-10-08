import { asSystem, sql } from '@wa/db';
import type { Job } from '../scheduler';

/**
 * Clears expired linking artefacts from `wa_sessions`.
 *
 * A pairing code is valid for a couple of minutes and a QR payload for about
 * twenty seconds. Both are short-lived secrets: anyone holding a live pairing
 * code can attach a device to the user's WhatsApp account. They are stored only
 * so the browser can poll for them, and they should not outlive their window in
 * the database.
 *
 * A session left in `pairing` with nothing to show is moved back to `pending`,
 * which is what the UI renders as "not linked yet — start again".
 */
export const expirePairingArtifacts: Job = {
  name: 'expire-pairing-artifacts',
  everyMs: 30_000,

  async run(ctx) {
    return asSystem(ctx.db, async (tx) => {
      const cleared = await tx.execute(sql`
        update wa_sessions
           set pairing_code = case
                 when pairing_code_expires_at <= now() then null
                 else pairing_code end,
               pairing_code_expires_at = case
                 when pairing_code_expires_at <= now() then null
                 else pairing_code_expires_at end,
               qr_payload = case
                 when qr_expires_at <= now() then null
                 else qr_payload end,
               qr_expires_at = case
                 when qr_expires_at <= now() then null
                 else qr_expires_at end,
               updated_at = now()
         where (pairing_code is not null and pairing_code_expires_at <= now())
            or (qr_payload is not null and qr_expires_at <= now())
        returning id`);

      // Nothing left to show and never linked: drop back to 'pending'.
      const reset = await tx.execute(sql`
        update wa_sessions
           set status = 'pending', updated_at = now()
         where status = 'pairing'
           and pairing_code is null
           and qr_payload is null
           and linked_at is null
        returning id`);

      const counts = { cleared: cleared.length, reset: reset.length };
      return counts.cleared + counts.reset > 0 ? counts : undefined;
    });
  },
};

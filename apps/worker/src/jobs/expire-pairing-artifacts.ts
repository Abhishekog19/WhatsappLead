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
 *
 * That reset also has to clear the credentials, and this is the subtle part.
 * Opening a socket writes a partial handshake (noise keys, a registration id)
 * long before anything is linked, so the column is non-NULL even though the
 * pairing never completed. maintain-sessions only picks up a `pending` row
 * whose credentials are NULL — it has no other way to tell "waiting to be
 * linked" from "linked and should reconnect" — so leaving them behind strands
 * the row in a state nothing acts on. The user sees "Starting" forever.
 *
 * Gated on `linked_at is null`, so this can never discard the credentials of
 * a number that genuinely did link.
 */
export const expirePairingArtifacts: Job = {
  name: 'expire-pairing-artifacts',
  everyMs: 30_000,
  // Pairing codes only exist while someone is linking a number, which is
  // rare. Nothing to expire means nobody is.
  idleEveryMs: 120_000,

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

      // Nothing left to show and never linked: drop back to 'pending' and
      // discard the half-finished handshake, so the row is eligible again.
      const reset = await tx.execute(sql`
        update wa_sessions
           set status = 'pending',
               creds_encrypted = null,
               last_error = 'The code expired before it was used',
               updated_at = now()
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

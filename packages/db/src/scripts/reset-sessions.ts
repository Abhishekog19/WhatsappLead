import postgres from 'postgres';
import { loadEnvFile } from '@wa/core';

/**
 * Unsticks sessions that are mid-handshake, so the worker starts them fresh.
 *
 * Run with: npm run db:reset-sessions --workspace=@wa/db
 *
 * For when a link attempt went wrong and you want to try again without
 * deleting the row and re-entering the number. Clearing the credentials is
 * the part that matters: a half-finished handshake is what makes the worker
 * treat the row as "already linked, reconnect it" rather than "waiting to be
 * linked".
 *
 * Deliberately leaves `connected`, `logged_out`, `banned` and `throttled`
 * alone. Resetting a throttled number would restart sending into a cap, which
 * is how a 24-hour hold becomes a ban, and the other three are not stuck.
 */
async function main(): Promise<void> {
  loadEnvFile();

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, prepare: false });

  try {
    const reset = await sql<
      { id: string; phone_e164: string | null; link_method: string }[]
    >`
      update wa_sessions
         set status = 'pending',
             creds_encrypted = null,
             pairing_code = null,
             pairing_code_expires_at = null,
             qr_payload = null,
             qr_expires_at = null,
             last_error = null,
             updated_at = now()
       where status in ('pairing', 'disconnected')
         and deleted_at is null
         -- Never touch a number that genuinely linked: its credentials are
         -- real, and a 'disconnected' status there just means the socket is
         -- down and the worker should reconnect it.
         and linked_at is null
      returning id, phone_e164, link_method
    `;

    if (reset.length === 0) {
      console.log('Nothing to reset — no session is stuck mid-handshake.');
      return;
    }

    console.log(`Reset ${reset.length} session(s):`);
    for (const row of reset) {
      console.log(`  ${row.phone_e164 ?? '(no number yet)'} via ${row.link_method}`);
    }
    console.log('\nThe worker picks these up within a few seconds.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('Failed to reset sessions:', err);
  process.exit(1);
});

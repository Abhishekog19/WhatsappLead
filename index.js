/**
 * WhatsApp Lead Outreach Automation
 * -----------------------------------
 * Reads leads from an Excel file, picks a message template based on each
 * lead's "Category" column, and sends personalized WhatsApp messages
 * one by one via your own logged-in WhatsApp Web session (whatsapp-web.js).
 *
 * No WhatsApp Business API, no per-message cost. Just your phone's WhatsApp
 * account logged in once via QR code.
 *
 * Features:
 *  - Daily send cap (hard stop at DAILY_CAP messages per calendar day)
 *  - Batch pacing: longer pause after every BATCH_SIZE sends within a run
 *  - Startup status line showing today's usage and pending lead count
 *  - sent-log.json keyed by phone number is the sole source of truth for
 *    who has already been messaged — works with growing or rotating Excel files
 *  - Per-category message variant arrays: one variant is picked at random per
 *    lead so no two recipients in the same category get identical wording
 *  - Simulated typing indicator before each send for a more human-looking UX
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ============================================================
// CONFIG — adjust these values to tune behaviour
// ============================================================

const EXCEL_PATH = process.env.LEADS_FILE || './leads.xlsx';
const TEMPLATES_PATH = './templates.json';
const LOG_PATH = './sent-log.json';

// Tracks messages sent today; resets automatically when the date changes.
const DAILY_COUNT_PATH = './daily-count.json';

// Hard cap: the script will not send more than this many messages in a
// single calendar day (across all runs on that day).
const DAILY_CAP = 50;

// After sending this many messages in one run, pause for a longer interval
// before continuing. Counter resets each time the script is launched.
const BATCH_SIZE = 15; // messages per batch before a long pause

// Per-message delay (ms) — randomized to look human and reduce ban risk.
const MIN_DELAY_MS = 25_000; // 25 s
const MAX_DELAY_MS = 55_000; // 55 s

// Longer pause taken between batches (ms).
const MIN_BATCH_PAUSE_MS = 45 * 60 * 1_000; // 45 minutes
const MAX_BATCH_PAUSE_MS = 90 * 60 * 1_000; // 90 minutes

// How long to hold the "typing..." indicator before sending (ms).
// Simulates a human composing the message; keeps it short to avoid timeout.
const MIN_TYPING_MS = 2_000; //  2 s
const MAX_TYPING_MS = 5_000; //  5 s

// Column names expected in your Excel file (edit if yours differ).
const COLS = {
  name: 'Name',
  phone: 'Phone',       // include country code, e.g. 919876543210 (no + or spaces)
  category: 'Category', // must match a key in templates.json
  business: 'Business', // optional, used in {{business}} placeholder
};

// ============================================================
// END OF CONFIG
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDelay() {
  return randomBetween(MIN_DELAY_MS, MAX_DELAY_MS);
}

function randomBatchPause() {
  return randomBetween(MIN_BATCH_PAUSE_MS, MAX_BATCH_PAUSE_MS);
}

/** Returns today's date as a YYYY-MM-DD string using local time. */
function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------- Daily-count helpers ----------

/**
 * Loads daily-count.json.
 * Automatically resets to 0 if the stored date differs from today,
 * so the cap always reflects the current calendar day.
 * Returns { date: "YYYY-MM-DD", count: N }.
 */
function loadDailyCount() {
  const today = todayString();
  if (fs.existsSync(DAILY_COUNT_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(DAILY_COUNT_PATH, 'utf-8'));
      if (data.date === today) return data; // same day — use stored count
    } catch (_) {
      // Corrupt file — fall through and reset.
    }
  }
  // First run of the day, or file missing/corrupt: start fresh.
  return { date: today, count: 0 };
}

/** Persists the updated daily count to disk after each successful send. */
function saveDailyCount(dailyCount) {
  fs.writeFileSync(DAILY_COUNT_PATH, JSON.stringify(dailyCount, null, 2));
}

// ---------- Template variant helper ----------

/**
 * Given a template entry (either a plain string for backwards-compatibility,
 * or an array of variant strings), returns one variant chosen uniformly at
 * random.  Arrays of length 1 work fine — the single item is always returned.
 *
 * To add more variants later, simply push additional strings into the
 * array for that category key in templates.json.
 */
function pickVariant(entry) {
  if (!entry) return null;
  // Support both the new array format and any legacy bare-string values.
  if (Array.isArray(entry)) {
    return entry[Math.floor(Math.random() * entry.length)];
  }
  return entry; // bare string — use as-is
}

// ---------- Existing helpers (unchanged) ----------

function loadTemplates() {
  if (!fs.existsSync(TEMPLATES_PATH)) {
    console.error(`Missing ${TEMPLATES_PATH}. Create it first (see templates.json example).`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf-8'));
}

function loadLeads() {
  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`Missing leads file at ${EXCEL_PATH}. Set LEADS_FILE env var or place leads.xlsx here.`);
    process.exit(1);
  }
  const workbook = XLSX.readFile(EXCEL_PATH);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return rows;
}

function loadLog() {
  if (fs.existsSync(LOG_PATH)) {
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8'));
  }
  return {};
}

function saveLog(log) {
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
}

function fillTemplate(template, lead) {
  return template
    .replace(/{{\s*name\s*}}/gi, lead[COLS.name] || 'there')
    .replace(/{{\s*business\s*}}/gi, lead[COLS.business] || 'your business');
}

function normalizePhone(raw) {
  // Strip spaces, dashes, plus signs. Expects country code included (e.g. 91XXXXXXXXXX).
  return String(raw).replace(/[^0-9]/g, '');
}

function askConfirmation(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

/** Formats a duration in ms into a human-readable "Xh Ym" or "Ym Xs" string. */
function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ---------- Main ----------

async function main() {
  const templates = loadTemplates();
  const leads = loadLeads();
  const log = loadLog();
  const dailyCount = loadDailyCount();

  // sent-log.json keyed by phone number is the sole source of truth for who
  // has already been messaged.  This works correctly whether the leads file
  // has grown (new rows appended) or been swapped out entirely.
  const pending = leads.filter((lead) => {
    const phone = normalizePhone(lead[COLS.phone]);
    return phone && !log[phone];
  });

  const remainingCap = DAILY_CAP - dailyCount.count;

  // ── Startup status line ──────────────────────────────────────────────────
  console.log(`\nSent today: ${dailyCount.count}/${DAILY_CAP}.  ${pending.length} lead(s) remaining unmessaged.\n`);
  // ────────────────────────────────────────────────────────────────────────

  if (pending.length === 0) {
    console.log('Nothing to send — all leads in the file have already been messaged. Exiting.');
    return;
  }

  if (remainingCap <= 0) {
    console.log(
      `Daily cap of ${DAILY_CAP} messages already reached for today (${dailyCount.date}). ` +
      `Run again tomorrow — the remaining ${pending.length} lead(s) will carry over automatically.`
    );
    return;
  }

  // Trim the list so we never exceed today's cap, even if there are more leads.
  const toSend = pending.slice(0, remainingCap);

  if (toSend.length < pending.length) {
    console.log(
      `Daily cap will be reached after ${toSend.length} message(s) today. ` +
      `The remaining ${pending.length - toSend.length} lead(s) will carry over to the next run.\n`
    );
  }

  // Show a preview of the first message (with the randomly-chosen variant)
  // so you can sanity-check before the loop starts.
  const preview = toSend[0];
  const previewCategory = (preview[COLS.category] || '').trim();
  const previewEntry    = templates[previewCategory] || templates.default;
  const previewVariant  = pickVariant(previewEntry);
  const previewVariantIdx = Array.isArray(previewEntry)
    ? previewEntry.indexOf(previewVariant) + 1  // 1-based for display
    : null;
  console.log('--- Preview of first message ---');
  console.log(`To: ${preview[COLS.name]} (${normalizePhone(preview[COLS.phone])})`);
  if (previewVariantIdx !== null) {
    console.log(`Variant ${previewVariantIdx}/${previewEntry.length} chosen for category "${previewCategory || 'default'}":`);
  }
  console.log(fillTemplate(previewVariant, preview));
  console.log('---------------------------------\n');

  const confirm = await askConfirmation(
    `About to send up to ${toSend.length} message(s) today ` +
    `(${MIN_DELAY_MS / 1000}–${MAX_DELAY_MS / 1000}s delays, ` +
    `batch pause every ${BATCH_SIZE}). Type "yes" to proceed: `
  );
  if (confirm !== 'yes') {
    console.log('Cancelled.');
    return;
  }

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox'] },
  });

  client.on('qr', (qr) => {
    console.log('Scan this QR code with WhatsApp on your phone (Linked Devices):');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', async () => {
    console.log('WhatsApp client ready. Starting send loop...\n');

    let sentThisRun = 0; // counts successful sends in this script invocation

    for (const lead of toSend) {
      const phone    = normalizePhone(lead[COLS.phone]);
      const category = (lead[COLS.category] || '').trim();

      // Pick a random variant from the category's array (or fall back to default).
      const templateEntry = templates[category] || templates.default;
      const variant       = pickVariant(templateEntry);

      if (!variant) {
        console.warn(`No template for category "${category}" and no default set. Skipping ${lead[COLS.name]}.`);
        continue;
      }

      const message = fillTemplate(variant, lead);

      try {
        const numberDetails = await client.getNumberId(phone);
        if (!numberDetails) {
          console.warn(`✗ ${lead[COLS.name]} (${phone}) — not on WhatsApp, skipping.`);
          log[phone] = { status: 'not_on_whatsapp', at: new Date().toISOString() };
          saveLog(log);
          continue;
        }

        // ── Typing indicator ────────────────────────────────────────────
        // Simulate a human composing the message before sending it.
        // Wrapped in its own try/catch: a failure here is non-fatal and
        // must never prevent the actual message from being delivered.
        try {
          const chat = await client.getChatById(numberDetails._serialized);
          await chat.sendStateTyping();
          const typingDelay = randomBetween(MIN_TYPING_MS, MAX_TYPING_MS);
          await sleep(typingDelay);
        } catch (typingErr) {
          console.warn(`  ⚠ Could not set typing state for ${phone}: ${typingErr.message} — continuing send.`);
        }
        // ────────────────────────────────────────────────────────────────

        await client.sendMessage(numberDetails._serialized, message);
        console.log(`✓ Sent to ${lead[COLS.name]} (${phone}) [${category || 'default'}]`);

        // Update both the per-number sent log and the daily counter.
        log[phone] = { status: 'sent', category, at: new Date().toISOString() };
        saveLog(log);

        dailyCount.count += 1;
        saveDailyCount(dailyCount);

        sentThisRun += 1;

      } catch (err) {
        console.error(`✗ Failed for ${lead[COLS.name]} (${phone}): ${err.message}`);
        log[phone] = { status: 'error', error: err.message, at: new Date().toISOString() };
        saveLog(log);
      }

      // ── Batch pause or per-message delay ──────────────────────────────
      const isLastMessage = lead === toSend[toSend.length - 1];
      const dailyCapHit  = dailyCount.count >= DAILY_CAP;

      if (!isLastMessage && !dailyCapHit) {
        if (sentThisRun > 0 && sentThisRun % BATCH_SIZE === 0) {
          // End of a batch — take the long pause before continuing.
          const pause = randomBatchPause();
          console.log(
            `\n⏸  Batch of ${BATCH_SIZE} complete ` +
            `(${dailyCount.count}/${DAILY_CAP} sent today). ` +
            `Pausing for ${formatDuration(pause)} before next batch...\n`
          );
          await sleep(pause);
          console.log('Resuming send loop.\n');
        } else {
          // Normal inter-message delay.
          const delay = randomDelay();
          console.log(`  waiting ${Math.round(delay / 1000)}s before next message...\n`);
          await sleep(delay);
        }
      }
      // ──────────────────────────────────────────────────────────────────
    }

    console.log(
      `\nAll done for today. Sent ${sentThisRun} message(s) this run ` +
      `(${dailyCount.count}/${DAILY_CAP} total today). See sent-log.json for the full record.`
    );
    process.exit(0);
  });

  client.on('auth_failure', (msg) => {
    console.error('Authentication failed:', msg);
  });

  client.on('disconnected', (reason) => {
    console.error('Client disconnected:', reason);
  });

  client.initialize();
}

main();

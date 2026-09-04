/**
 * WhatsApp Lead Outreach Automation
 * -----------------------------------
 * Reads leads from an Excel file, picks a message template based on each
 * lead's "Category" column, and sends personalized WhatsApp messages
 * one by one via your own logged-in WhatsApp Web session (whatsapp-web.js).
 *
 * No WhatsApp Business API, no per-message cost. Just your phone's WhatsApp
 * account logged in once via QR code.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---------- CONFIG ----------
const EXCEL_PATH = process.env.LEADS_FILE || './leads.xlsx';
const TEMPLATES_PATH = './templates.json';
const LOG_PATH = './sent-log.json';

// Delay range (ms) between messages — randomized to look human and reduce ban risk.
const MIN_DELAY_MS = 25000; // 25s
const MAX_DELAY_MS = 55000; // 55s

// Column names expected in your Excel file (edit if yours differ)
const COLS = {
  name: 'Name',
  phone: 'Phone',       // include country code, e.g. 919876543210 (no + or spaces)
  category: 'Category',  // must match a key in templates.json
  business: 'Business',  // optional, used in {{business}} placeholder
};
// -----------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

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
  let digits = String(raw).replace(/[^0-9]/g, '');
  return digits;
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

async function main() {
  const templates = loadTemplates();
  const leads = loadLeads();
  const log = loadLog();

  const pending = leads.filter((lead) => {
    const phone = normalizePhone(lead[COLS.phone]);
    return phone && !log[phone];
  });

  console.log(`Loaded ${leads.length} leads. ${pending.length} not yet messaged.`);
  if (pending.length === 0) {
    console.log('Nothing to send. Exiting.');
    return;
  }

  // Show a preview of the first message so you can sanity-check before it starts blasting.
  const preview = pending[0];
  const previewCategory = (preview[COLS.category] || '').trim();
  const previewTemplate = templates[previewCategory] || templates.default;
  console.log('\n--- Preview of first message ---');
  console.log(`To: ${preview[COLS.name]} (${normalizePhone(preview[COLS.phone])})`);
  console.log(fillTemplate(previewTemplate, preview));
  console.log('---------------------------------\n');

  const confirm = await askConfirmation(`About to message ${pending.length} leads with ${MIN_DELAY_MS / 1000}-${MAX_DELAY_MS / 1000}s delays. Type "yes" to proceed: `);
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

    for (const lead of pending) {
      const phone = normalizePhone(lead[COLS.phone]);
      const category = (lead[COLS.category] || '').trim();
      const template = templates[category] || templates.default;

      if (!template) {
        console.warn(`No template for category "${category}" and no default set. Skipping ${lead[COLS.name]}.`);
        continue;
      }

      const message = fillTemplate(template, lead);
      const chatId = `${phone}@c.us`;

      try {
        const numberDetails = await client.getNumberId(phone);
        if (!numberDetails) {
          console.warn(`✗ ${lead[COLS.name]} (${phone}) — not on WhatsApp, skipping.`);
          log[phone] = { status: 'not_on_whatsapp', at: new Date().toISOString() };
          saveLog(log);
          continue;
        }

        await client.sendMessage(numberDetails._serialized, message);
        console.log(`✓ Sent to ${lead[COLS.name]} (${phone}) [${category || 'default'}]`);
        log[phone] = { status: 'sent', category, at: new Date().toISOString() };
        saveLog(log);
      } catch (err) {
        console.error(`✗ Failed for ${lead[COLS.name]} (${phone}): ${err.message}`);
        log[phone] = { status: 'error', error: err.message, at: new Date().toISOString() };
        saveLog(log);
      }

      const delay = randomDelay();
      console.log(`  waiting ${Math.round(delay / 1000)}s before next message...\n`);
      await sleep(delay);
    }

    console.log('All done. See sent-log.json for the full record.');
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

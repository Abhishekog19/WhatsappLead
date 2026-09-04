# WhatsApp Lead Outreach Automation

Sends personalized WhatsApp messages to leads from your Excel sheet, one by one,
using your own WhatsApp Web session — no WhatsApp Business API, no per-message fees.

It works by driving a real logged-in WhatsApp Web session in the background
(via `whatsapp-web.js`, which uses a headless Chrome browser). You scan a QR
code once, like linking a device, and it stays logged in after that.

## 1. Install

```bash
cd whatsapp-automation
npm install
```

This pulls in `whatsapp-web.js` (WhatsApp Web automation), `xlsx` (Excel
reading), and `qrcode-terminal` (to show the login QR in your terminal).
First install may take a minute since it also downloads a Chromium browser.

## 2. Prepare your leads file

Export/save your gscrape leads as `leads.xlsx` in this folder, with these
columns (case-sensitive, edit `COLS` in `index.js` if your headers differ):

| Name        | Phone          | Category      | Business             |
|-------------|----------------|---------------|-----------------------|
| Rohan Sharma| 919876543210   | no_website    | Sharma Electricals    |
| Priya Mehta | 919812345678   | clinic        | Mehta Dental Clinic   |

- **Phone**: include country code, digits only (no `+`, spaces, or dashes).
- **Category**: must match a key in `templates.json` (or it falls back to `"default"`).

A sample is in `leads-example.csv` for reference.

## 3. Edit your message templates

Open `templates.json` and write one message per lead category. Use
`{{name}}` and `{{business}}` as placeholders — they get filled in per lead.
Add as many categories as you want; just make sure the `Category` column in
your Excel matches the keys exactly.

## 4. Run it

```bash
npm start
```

- First run: a QR code prints in your terminal. Open WhatsApp on your phone →
  **Settings → Linked Devices → Link a Device** → scan it. This only needs to
  happen once; your session is saved locally in a `.wwebjs_auth` folder.
- It will show you a **preview of the first message** and ask you to type
  `yes` before sending anything — so you can catch template mistakes early.
- Messages send one at a time with a **randomized 25–55 second delay**
  between each (edit `MIN_DELAY_MS` / `MAX_DELAY_MS` in `index.js`). This
  matters — sending too fast, back-to-back, is the main way people get their
  WhatsApp number flagged or banned. Don't be tempted to set this to zero.
- Every lead's status (sent / failed / not-on-WhatsApp) is saved to
  `sent-log.json`. If you stop the script and rerun it later, it **skips
  anyone already logged** — so you can safely re-run without double-messaging
  people.

## Notes on safety and limits

- This automates *your own* WhatsApp account acting like a person clicking
  send — it is not the official Business API, so there's no guaranteed
  uptime/support and it can break if WhatsApp changes WhatsApp Web's
  internals (the `whatsapp-web.js` library usually patches these fairly
  fast, but occasional breakage is normal for this kind of tool).
- Because this is unofficial automation, sending too many messages too fast,
  or messaging people who mark you as spam/block you, risks your number
  getting rate-limited or banned by WhatsApp. Keep volumes reasonable
  (dozens/day rather than hundreds), keep the delay, and personalize your
  templates so they don't read as generic spam.
- Consider using a secondary WhatsApp number for outreach rather than your
  primary one, especially while you're testing.
- This tool is best suited for outreach to leads who'd plausibly expect a
  message from you (you scraped them as a prospect for your exact service).
  It isn't a mass-blast tool — treat it like you're the one manually typing,
  just automated.

## Troubleshooting

- **QR code won't scan / times out**: rerun `npm start`, a fresh QR is
  generated each time.
- **"not on WhatsApp" for real numbers**: double check the phone column has
  the correct country code with no leading `+` or `0`.
- **Session logged out unexpectedly**: delete the `.wwebjs_auth` folder and
  re-scan the QR code.

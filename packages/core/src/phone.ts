import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Phone normalisation to E.164.
 *
 * Every phone number in the system is stored in exactly one shape: E.164
 * ("+919876543210"). Deduplication, suppression lists and the new-contact
 * ledger all key off it, so a number that normalises inconsistently would
 * silently defeat all three.
 *
 * The original script did `String(raw).replace(/[^0-9]/g, '')`, which cannot
 * distinguish "9876543210" (local) from "919876543210" (with country code),
 * and mangles the three shapes Excel routinely produces.
 */

export type NormalizeResult =
  | { ok: true; e164: string; country: string | undefined }
  | { ok: false; reason: NormalizeError; input: string };

export type NormalizeError =
  | 'empty'
  | 'not_a_number'
  | 'too_short'
  | 'invalid'
  | 'scientific_notation';

/**
 * Excel stores long digit strings as floats and hands them back as
 * "9.19876543211e+11" or "919876543210.0". Both are recoverable; a value
 * that lost precision is not, and must be rejected rather than guessed at.
 */
function fromExcelNumeric(raw: string): string | null {
  const sci = /^(\d(?:\.\d+)?)e\+?(\d+)$/i.exec(raw.trim());
  if (sci) {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isSafeInteger(n)) return null;
    return String(n);
  }
  const trailingZero = /^(\d+)\.0+$/.exec(raw.trim());
  if (trailingZero) return trailingZero[1] ?? null;
  return null;
}

/**
 * @param raw        Whatever the spreadsheet cell contained.
 * @param defaultCountry ISO-3166 alpha-2 used when the number has no country
 *                       code of its own (e.g. a bare 10-digit Indian mobile).
 */
export function normalizePhone(
  raw: unknown,
  defaultCountry: string = 'IN',
): NormalizeResult {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: 'empty', input: '' };
  }

  let input = String(raw).trim();
  if (!input) return { ok: false, reason: 'empty', input };

  // Recover Excel's float mangling before anything else looks at the string.
  if (/e\+?\d/i.test(input) || /\.\d*0$/.test(input)) {
    const recovered = fromExcelNumeric(input);
    if (recovered === null && /e\+?\d/i.test(input)) {
      return { ok: false, reason: 'scientific_notation', input };
    }
    if (recovered !== null) input = recovered;
  }

  // Strip formatting noise but keep a leading + as the "has country code" hint.
  const hasPlus = input.startsWith('+');
  let digits = input.replace(/[^\d]/g, '');
  if (!digits) return { ok: false, reason: 'not_a_number', input };

  // "00" is the international prefix in most of the world; libphonenumber
  // understands it only with the leading +.
  if (!hasPlus && digits.startsWith('00')) {
    digits = digits.slice(2);
    return finish(`+${digits}`, undefined, input);
  }

  if (digits.length < 6) return { ok: false, reason: 'too_short', input };

  const candidate = hasPlus ? `+${digits}` : digits;
  return finish(candidate, hasPlus ? undefined : (defaultCountry as CountryCode), input);
}

function finish(
  candidate: string,
  country: CountryCode | undefined,
  input: string,
): NormalizeResult {
  const parsed = parsePhoneNumberFromString(candidate, country);
  if (!parsed || !parsed.isValid()) {
    return { ok: false, reason: 'invalid', input };
  }
  return { ok: true, e164: parsed.number, country: parsed.country };
}

/** WhatsApp addresses chats as "<digits>@s.whatsapp.net" (no plus). */
export function toWhatsAppJid(e164: string): string {
  return `${e164.replace(/^\+/, '')}@s.whatsapp.net`;
}

/** Inverse of {@link toWhatsAppJid}, tolerant of @c.us and @lid forms. */
export function fromWhatsAppJid(jid: string): string {
  const user = jid.split('@')[0] ?? '';
  // Multi-device JIDs carry a ":<device>" suffix.
  const bare = user.split(':')[0] ?? '';
  return `+${bare}`;
}

/** Display form for the UI: "+91 98765 43210". */
export function formatForDisplay(e164: string, defaultCountry = 'IN'): string {
  const parsed = parsePhoneNumberFromString(e164, defaultCountry as CountryCode);
  return parsed?.formatInternational() ?? e164;
}

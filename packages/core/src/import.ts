import { normalizePhone } from './phone';

/**
 * Spreadsheet import.
 *
 * The file-format decoding lives in the web app; everything here is pure, so
 * the same rules that decide what gets imported also produce the preview the
 * user approves before anything is written.
 *
 * The design principle is that a spreadsheet should import without being
 * reformatted. Real lead lists come out of scrapers and CRMs with whatever
 * column names those tools chose, so rather than demanding a fixed layout
 * this guesses the two columns that matter and keeps every other column
 * verbatim as a template placeholder.
 */

export interface ColumnMapping {
  /** Header of the column holding the phone number. Required. */
  phone: string;
  /** Header holding the person or business name. Optional but recommended. */
  name?: string | null;
  /** Headers to ignore entirely — nothing is stored from them. */
  ignore?: readonly string[];
}

export interface ImportRow {
  phoneE164: string;
  name: string | null;
  /** Every non-ignored column, available to templates as {{Header}}. */
  fields: Record<string, string>;
  /** 1-based row number in the original file, for error messages. */
  sourceRow: number;
}

export type RejectReason =
  | 'missing_phone'
  | 'invalid_phone'
  | 'duplicate_in_file';

export interface RejectedRow {
  sourceRow: number;
  reason: RejectReason;
  /** The raw cell value, so the user can see what failed. */
  value: string;
  name: string | null;
}

export interface ImportResult {
  rows: ImportRow[];
  rejected: RejectedRow[];
  /** Headers preserved as template placeholders, in file order. */
  columns: string[];
  totalRows: number;
}

/**
 * Header names that are almost certainly a phone number, best guess first.
 * Matching is on a normalised form, so "Phone Number" and "phone_number" and
 * "PhoneNumber" all collapse to the same key.
 */
const PHONE_HINTS = [
  'phone',
  'phonenumber',
  'mobile',
  'mobilenumber',
  'whatsapp',
  'whatsappnumber',
  'contact',
  'contactnumber',
  'number',
  'tel',
  'telephone',
  'cell',
  'msisdn',
];

const NAME_HINTS = [
  'name',
  'businessname',
  'business',
  'company',
  'companyname',
  'clinic',
  'clinicname',
  'contactname',
  'fullname',
  'firstname',
  'title',
  'owner',
];

/**
 * Columns that are generated rather than source data. Keeping them would
 * store a stale pre-rendered message alongside the template that replaces it,
 * which is exactly the kind of thing that later gets sent by accident.
 */
const NOISE_HINTS = [
  'whatsapplink',
  'walink',
  'googlemapsurl',
  'mapsurl',
  'mapurl',
  'status',
];

function key(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A cell that means "nothing here" in practice. */
function isBlank(value: string): boolean {
  const v = value.trim();
  return v === '' || v === '-' || v === '—' || v === 'n/a' || v === 'N/A';
}

export interface MappingGuess extends ColumnMapping {
  /** Columns that look generated and are pre-ticked for exclusion. */
  suggestedIgnore: string[];
}

/**
 * Guesses which columns are the phone and the name.
 *
 * Returned as a suggestion the user confirms, never applied silently: a
 * wrong phone column would send every message to the wrong people, which is
 * not a mistake worth automating away.
 */
export function guessMapping(headers: readonly string[]): MappingGuess {
  const scored = headers.map((h) => ({ header: h, k: key(h) }));

  const byHint = (hints: readonly string[]): string | null => {
    // Exact match beats a substring match, so a sheet with both "Phone" and
    // "Phone Type" picks the right one.
    for (const hint of hints) {
      const exact = scored.find((s) => s.k === hint);
      if (exact) return exact.header;
    }
    for (const hint of hints) {
      const partial = scored.find((s) => s.k.includes(hint));
      if (partial) return partial.header;
    }
    return null;
  };

  const phone = byHint(PHONE_HINTS) ?? headers[0] ?? '';
  const name = byHint(NAME_HINTS.filter((h) => key(phone) !== h));

  const suggestedIgnore = headers.filter((h) =>
    NOISE_HINTS.some((hint) => key(h) === hint || key(h).includes(hint)),
  );

  return {
    phone,
    name: name && name !== phone ? name : null,
    suggestedIgnore,
  };
}

/**
 * Applies a mapping to decoded spreadsheet rows.
 *
 * Deduplication here is only within the file. Checking against contacts the
 * user already holds needs the database and happens at insert time.
 */
export function mapRows(
  rows: readonly Record<string, unknown>[],
  mapping: ColumnMapping,
  options: { defaultCountry?: string } = {},
): ImportResult {
  const defaultCountry = options.defaultCountry ?? 'IN';
  const ignore = new Set((mapping.ignore ?? []).map(key));
  ignore.add(key(mapping.phone));

  const headers = rows.length > 0 ? Object.keys(rows[0] as object) : [];
  const columns = headers.filter((h) => !ignore.has(key(h)));

  const out: ImportRow[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Set<string>();

  rows.forEach((row, index) => {
    // +2: row 1 is the header, and spreadsheet rows are 1-based.
    const sourceRow = index + 2;

    const rawName = mapping.name ? stringify(row[mapping.name]) : '';
    const name = isBlank(rawName) ? null : rawName.trim();

    const rawPhone = stringify(row[mapping.phone]);
    if (isBlank(rawPhone)) {
      rejected.push({ sourceRow, reason: 'missing_phone', value: rawPhone, name });
      return;
    }

    const parsed = normalizePhone(rawPhone, defaultCountry);
    if (!parsed.ok) {
      rejected.push({ sourceRow, reason: 'invalid_phone', value: rawPhone, name });
      return;
    }

    if (seen.has(parsed.e164)) {
      rejected.push({ sourceRow, reason: 'duplicate_in_file', value: rawPhone, name });
      return;
    }
    seen.add(parsed.e164);

    const fields: Record<string, string> = {};
    for (const header of columns) {
      const value = stringify(row[header]);
      if (!isBlank(value)) fields[header] = value.trim();
    }

    out.push({ phoneE164: parsed.e164, name, fields, sourceRow });
  });

  return { rows: out, rejected, columns, totalRows: rows.length };
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/** Upper bound on one upload, to keep a single request from exhausting memory. */
export const MAX_IMPORT_ROWS = 20_000;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Message rendering.
 *
 * Lives in core rather than in the worker so that the preview a user sees in
 * the browser is produced by the exact same code path that sends — a preview
 * that diverges from reality is worse than no preview.
 *
 * Two independent mechanisms reduce the "thousands of byte-identical
 * messages" fingerprint that spam classifiers key on:
 *   - VARIANTS: whole alternative bodies, rotated per recipient.
 *   - SPINTAX:  inline alternatives, `{Hi|Hello|Hey}`, chosen per render.
 */

export interface RenderVars {
  [key: string]: string | number | null | undefined;
}

export interface RenderResult {
  text: string;
  /** Placeholders present in the template that had no value supplied. */
  missing: string[];
}

const PLACEHOLDER = /\{\{\s*([\w .-]+?)\s*\}\}/g;

/** Lists the `{{...}}` placeholders in a template, de-duplicated, in order. */
export function extractPlaceholders(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) {
    const key = (m[1] ?? '').trim();
    const lower = key.toLowerCase();
    if (key && !seen.has(lower)) {
      seen.add(lower);
      out.push(key);
    }
  }
  return out;
}

/**
 * Expands `{a|b|c}` groups, innermost first so nesting works.
 * `rand` is injectable to make rendering deterministic in tests and previews.
 */
export function expandSpintax(body: string, rand: () => number = Math.random): string {
  // Innermost group: braces containing a pipe and no nested braces.
  const group = /\{([^{}]*\|[^{}]*)\}/;
  let out = body;
  // Bounded to stop a pathological template from spinning forever.
  for (let i = 0; i < 100; i++) {
    const m = group.exec(out);
    if (!m) break;
    const options = (m[1] ?? '').split('|');
    const choice = options[Math.floor(rand() * options.length)] ?? '';
    out = out.slice(0, m.index) + choice + out.slice(m.index + m[0].length);
  }
  return out;
}

/**
 * Substitutes `{{Placeholder}}` from `vars`, matching keys case-insensitively
 * and ignoring spaces/underscores so a "Business Name" column fills
 * `{{business_name}}`.
 */
export function renderTemplate(
  body: string,
  vars: RenderVars,
  options: { rand?: () => number; expandSpintax?: boolean } = {},
): RenderResult {
  const lookup = new Map<string, string>();
  for (const [k, v] of Object.entries(vars)) {
    if (v === null || v === undefined) continue;
    const value = String(v).trim();
    if (!value) continue;
    lookup.set(normaliseKey(k), value);
  }

  const missing: string[] = [];
  let text = body.replace(PLACEHOLDER, (_full, rawKey: string) => {
    const key = rawKey.trim();
    const value = lookup.get(normaliseKey(key));
    if (value === undefined) {
      missing.push(key);
      return '';
    }
    return value;
  });

  if (options.expandSpintax !== false) {
    text = expandSpintax(text, options.rand);
  }

  // Dropping a placeholder can leave "Hi ," or a double space behind.
  text = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, missing };
}

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[\s_.-]/g, '');
}

/**
 * Picks a variant. Passing a stable `seed` (the contact id) spreads variants
 * evenly and makes a resend after a crash reuse the same body rather than
 * sending the recipient a second, differently-worded message.
 */
export function pickVariant<T>(variants: readonly T[], seed?: string): T | undefined {
  if (variants.length === 0) return undefined;
  if (variants.length === 1) return variants[0];
  if (seed === undefined) return variants[Math.floor(Math.random() * variants.length)];

  // FNV-1a — small, stable across processes, good enough for bucketing.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return variants[hash % variants.length];
}

/** WhatsApp rejects bodies over this length. */
export const MAX_MESSAGE_LENGTH = 4096;

export interface TemplateProblem {
  level: 'error' | 'warning';
  message: string;
}

/** Validation surfaced in the template editor before a campaign can start. */
export function validateTemplate(
  body: string,
  availableColumns: readonly string[] = [],
): TemplateProblem[] {
  const problems: TemplateProblem[] = [];

  if (!body.trim()) {
    problems.push({ level: 'error', message: 'Message body is empty.' });
    return problems;
  }

  if (body.length > MAX_MESSAGE_LENGTH) {
    problems.push({
      level: 'error',
      message: `Message is ${body.length} characters; WhatsApp allows ${MAX_MESSAGE_LENGTH}.`,
    });
  }

  const openBraces = (body.match(/\{/g) ?? []).length;
  const closeBraces = (body.match(/\}/g) ?? []).length;
  if (openBraces !== closeBraces) {
    problems.push({
      level: 'error',
      message: 'Unbalanced { } braces — check your placeholders and spin groups.',
    });
  }

  if (availableColumns.length > 0) {
    const known = new Set(availableColumns.map(normaliseKey));
    for (const p of extractPlaceholders(body)) {
      if (!known.has(normaliseKey(p))) {
        problems.push({
          level: 'warning',
          message: `{{${p}}} has no matching column and will be left blank.`,
        });
      }
    }
  }

  if (extractPlaceholders(body).length === 0 && !/\{[^{}]*\|/.test(body)) {
    problems.push({
      level: 'warning',
      message:
        'Every recipient gets an identical message. Adding {{Name}} or a {choice|of|words} lowers the chance of being flagged as spam.',
    });
  }

  return problems;
}

import { z } from 'zod';

/**
 * Validation for the settings form.
 *
 * Split out of the Server Action so it can be tested without a session, a
 * database or a browser. Everything here changes how fast someone's WhatsApp
 * number sends, which makes it the last place to find out a rule is wrong by
 * watching the form silently refuse to save.
 *
 * The bounds are not arbitrary. A 5-second gap between messages is a bot
 * signature, and a cap above the platform ceiling would be clamped anyway.
 */

export const SETTINGS_BOUNDS = {
  minDelayMs: { min: 10_000, max: 600_000 },
  maxDelayMs: { min: 10_000, max: 1_800_000 },
  batchSize: { min: 1, max: 100 },
  newContactCap24h: { min: 1, max: 500 },
  cooldownDays: { min: 1, max: 3_650 },
} as const;

const schema = z
  .object({
    dedupeMode: z.enum(['never_repeat', 'cooldown', 'off']),
    cooldownDays: z.coerce
      .number()
      .int()
      .min(SETTINGS_BOUNDS.cooldownDays.min)
      .max(SETTINGS_BOUNDS.cooldownDays.max),
    newContactCap24h: z
      .union([
        z.coerce
          .number()
          .int()
          .min(SETTINGS_BOUNDS.newContactCap24h.min)
          .max(SETTINGS_BOUNDS.newContactCap24h.max),
        z.literal(''),
      ])
      .transform((v) => (v === '' ? null : v)),
    warmupEnabled: z.boolean(),
    minDelayMs: z.coerce
      .number()
      .int()
      .min(SETTINGS_BOUNDS.minDelayMs.min, 'Leave at least 10 seconds between messages.')
      .max(SETTINGS_BOUNDS.minDelayMs.max),
    maxDelayMs: z.coerce
      .number()
      .int()
      .min(SETTINGS_BOUNDS.maxDelayMs.min, 'Leave at least 10 seconds between messages.')
      .max(SETTINGS_BOUNDS.maxDelayMs.max),
    batchSize: z.coerce
      .number()
      .int()
      .min(SETTINGS_BOUNDS.batchSize.min)
      .max(SETTINGS_BOUNDS.batchSize.max),
    sendWindowStartHour: z.coerce.number().int().min(0).max(23),
    sendWindowEndHour: z.coerce.number().int().min(1).max(24),
    skipWeekends: z.boolean(),
    timezone: z.string().min(1).max(64),
    defaultCountry: z.string().length(2).toUpperCase(),
  })
  .refine((v) => v.maxDelayMs >= v.minDelayMs, {
    path: ['maxDelayMs'],
    message: 'Maximum delay must be at least the minimum delay.',
  })
  .refine((v) => v.sendWindowEndHour > v.sendWindowStartHour, {
    path: ['sendWindowEndHour'],
    message:
      'The finish time has to be later than the start time. Overnight windows are not supported.',
  });

export type SettingsInput = z.infer<typeof schema>;

export type ParseResult =
  | { ok: true; value: SettingsInput }
  | { ok: false; message: string; fieldErrors: Record<string, string> };

/**
 * Reads the form.
 *
 * `formData.get` returns null for a field the form did not submit, and the
 * difference between null and an empty string matters: an unchecked checkbox
 * is absent entirely, while a cleared number input submits "".
 */
export function parseSettingsForm(formData: FormData): ParseResult {
  const text = (name: string): string =>
    typeof formData.get(name) === 'string' ? String(formData.get(name)) : '';

  // The delay inputs are in seconds, because nobody wants to type 25000.
  const seconds = (name: string): number => {
    const value = text(name);
    const n = Number(value);
    return value !== '' && Number.isFinite(n) ? Math.round(n * 1000) : Number.NaN;
  };

  const raw = {
    dedupeMode: text('dedupeMode'),
    cooldownDays: text('cooldownDays'),
    newContactCap24h: text('newContactCap24h'),
    // Checkboxes submit "on" when ticked and are absent when not.
    warmupEnabled: formData.get('warmupEnabled') === 'on',
    minDelayMs: seconds('minDelaySeconds'),
    maxDelayMs: seconds('maxDelaySeconds'),
    batchSize: text('batchSize'),
    sendWindowStartHour: text('sendWindowStartHour'),
    sendWindowEndHour: text('sendWindowEndHour'),
    skipWeekends: formData.get('skipWeekends') === 'on',
    timezone: text('timezone'),
    defaultCountry: text('defaultCountry'),
  };

  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };

  const fieldErrors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
  }

  // Name the fields in the summary. The previous wording — "some values need
  // fixing" — left someone who had scrolled to the bottom hunting for which,
  // and reading it as the form having silently reverted.
  const names = Object.keys(fieldErrors).map(fieldLabel).join(', ');
  return {
    ok: false,
    message: names ? `Could not save — check ${names}.` : 'Could not save those values.',
    fieldErrors,
  };
}

const LABELS: Record<string, string> = {
  dedupeMode: 'the duplicate rule',
  cooldownDays: 'the cooldown',
  newContactCap24h: 'the daily limit',
  minDelayMs: 'the minimum gap',
  maxDelayMs: 'the maximum gap',
  batchSize: 'the batch size',
  sendWindowStartHour: 'the start time',
  sendWindowEndHour: 'the finish time',
  timezone: 'the time zone',
  defaultCountry: 'the country code',
};

function fieldLabel(key: string): string {
  return LABELS[key] ?? key;
}

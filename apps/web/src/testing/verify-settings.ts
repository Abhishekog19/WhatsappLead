/**
 * Settings form validation.
 *
 * Run with: npm run verify --workspace=@wa/web
 *
 * No database and no browser: the point is the parsing rules, which decide
 * whether someone can change how fast their number sends. When this silently
 * rejected a form, the symptom was the page appearing to revert — a save that
 * fails and a save that does not stick look identical from the outside, which
 * is why the rules are asserted here rather than discovered there.
 */

import { parseSettingsForm, SETTINGS_BOUNDS } from '../app/dashboard/settings/schema';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(
      `  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    );
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** What the browser actually submits for this form. */
function form(over: Record<string, string> = {}, omit: string[] = []): FormData {
  const base: Record<string, string> = {
    dedupeMode: 'never_repeat',
    cooldownDays: '90',
    newContactCap24h: '',
    warmupEnabled: 'on',
    minDelaySeconds: '25',
    maxDelaySeconds: '55',
    batchSize: '15',
    sendWindowStartHour: '10',
    sendWindowEndHour: '19',
    timezone: 'Asia/Kolkata',
    defaultCountry: 'IN',
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...over })) {
    if (omit.includes(k)) continue;
    fd.set(k, v);
  }
  return fd;
}

function main(): void {
  section('An untouched form saves unchanged');

  const untouched = parseSettingsForm(form());
  check('parses', untouched.ok, untouched.ok ? undefined : untouched.fieldErrors);
  if (untouched.ok) {
    check('hours round-trip', untouched.value.sendWindowStartHour === 10 &&
      untouched.value.sendWindowEndHour === 19);
    check('seconds become milliseconds', untouched.value.minDelayMs === 25_000 &&
      untouched.value.maxDelayMs === 55_000);
    check('an empty cap means "use my tier"', untouched.value.newContactCap24h === null);
  }

  section('Changing the sending hours');

  // The case that started this: the hours were saving correctly all along, and
  // the form was showing stale values. These pin the parsing half.
  for (const [start, end] of [
    ['7', '19'],
    ['0', '24'],
    ['9', '10'],
    ['23', '24'],
  ] as const) {
    const r = parseSettingsForm(
      form({ sendWindowStartHour: start, sendWindowEndHour: end }),
    );
    check(
      `${start}:00–${end}:00 is accepted`,
      r.ok && r.value.sendWindowStartHour === Number(start) &&
        r.value.sendWindowEndHour === Number(end),
      r.ok ? undefined : r.fieldErrors,
    );
  }

  const inverted = parseSettingsForm(
    form({ sendWindowStartHour: '20', sendWindowEndHour: '6' }),
  );
  check(
    'an overnight window is refused',
    !inverted.ok && Boolean(inverted.fieldErrors.sendWindowEndHour),
  );
  check(
    'and the message names the field, rather than saying "some values"',
    !inverted.ok && inverted.message.includes('finish time'),
    inverted.ok ? undefined : inverted.message,
  );

  const same = parseSettingsForm(
    form({ sendWindowStartHour: '10', sendWindowEndHour: '10' }),
  );
  check('a zero-length window is refused', !same.ok);

  section('Checkboxes');

  // An unticked checkbox is absent from FormData entirely, which is a classic
  // way to read `false` as "field missing" and reject the whole form.
  const noWarmup = parseSettingsForm(form({}, ['warmupEnabled']));
  check(
    'an unticked warm-up box parses as false, not as missing',
    noWarmup.ok && noWarmup.value.warmupEnabled === false,
    noWarmup.ok ? undefined : noWarmup.fieldErrors,
  );

  const weekends = parseSettingsForm(form({ skipWeekends: 'on' }));
  check(
    'a ticked weekend box parses as true',
    weekends.ok && weekends.value.skipWeekends === true,
  );
  check(
    'and an absent one as false',
    untouched.ok && untouched.value.skipWeekends === false,
  );

  section('Pacing bounds exist to stop a bot signature');

  const tooFast = parseSettingsForm(form({ minDelaySeconds: '5', maxDelaySeconds: '9' }));
  check('a 5-second gap is refused', !tooFast.ok);
  check(
    'with wording that says what to do',
    !tooFast.ok && /10 seconds/.test(tooFast.message + JSON.stringify(tooFast.fieldErrors)),
    tooFast.ok ? undefined : tooFast.fieldErrors,
  );

  const atFloor = parseSettingsForm(
    form({ minDelaySeconds: '10', maxDelaySeconds: '10' }),
  );
  check(
    'exactly the floor is allowed',
    atFloor.ok && atFloor.value.minDelayMs === SETTINGS_BOUNDS.minDelayMs.min,
    atFloor.ok ? undefined : atFloor.fieldErrors,
  );

  const backwards = parseSettingsForm(
    form({ minDelaySeconds: '60', maxDelaySeconds: '30' }),
  );
  check('a max below the min is refused', !backwards.ok);

  const blankDelay = parseSettingsForm(form({ minDelaySeconds: '' }));
  check('a cleared gap field is refused rather than read as zero', !blankDelay.ok);

  section('The daily cap');

  const capped = parseSettingsForm(form({ newContactCap24h: '60' }));
  check('a number is kept', capped.ok && capped.value.newContactCap24h === 60);

  const silly = parseSettingsForm(form({ newContactCap24h: '5000' }));
  check('an absurd cap is refused', !silly.ok);

  const zero = parseSettingsForm(form({ newContactCap24h: '0' }));
  check('zero is refused — "send nothing" is what pausing is for', !zero.ok);

  section('Other fields');

  const lower = parseSettingsForm(form({ defaultCountry: 'in' }));
  check(
    'a lowercase country code is accepted and upper-cased',
    lower.ok && lower.value.defaultCountry === 'IN',
    lower.ok ? undefined : lower.fieldErrors,
  );

  const badCountry = parseSettingsForm(form({ defaultCountry: 'IND' }));
  check('a three-letter country code is refused', !badCountry.ok);

  const badMode = parseSettingsForm(form({ dedupeMode: 'whatever' }));
  check('an unknown dedupe mode is refused', !badMode.ok);

  console.log(
    `\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`,
  );
  if (failures.length > 0) process.exit(1);
}

main();

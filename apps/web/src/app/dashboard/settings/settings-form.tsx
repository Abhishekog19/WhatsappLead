'use client';

import { useActionState, useId, useState } from 'react';
import { saveSettings, type SaveResult } from './actions';

export interface SettingsValues {
  dedupeMode: 'never_repeat' | 'cooldown' | 'off';
  cooldownDays: number;
  newContactCap24h: number | null;
  warmupEnabled: boolean;
  minDelayMs: number;
  maxDelayMs: number;
  batchSize: number;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
  skipWeekends: boolean;
  timezone: string;
  defaultCountry: string;
}

const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
];

export function SettingsForm({ values }: { values: SettingsValues }) {
  const [state, action, pending] = useActionState<SaveResult | null, FormData>(
    saveSettings,
    null,
  );

  // Controlled only where the UI needs to react — showing the cooldown field
  // depends on the selected dedupe mode.
  const [dedupeMode, setDedupeMode] = useState(values.dedupeMode);

  return (
    <form action={action} className="space-y-6">
      {state ? (
        <p
          role="status"
          className={`rounded-xl p-3 text-sm ${
            state.ok
              ? 'border border-brand-200 bg-brand-50 text-brand-800 dark:border-brand-900 dark:bg-brand-950 dark:text-brand-200'
              : 'border border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200'
          }`}
        >
          {state.message}
        </p>
      ) : null}

      <Fieldset
        legend="Don't message the same person twice"
        hint="This only looks at numbers you have messaged. Other people's activity never blocks yours."
      >
        <Field label="When a number is already in your history" error={state?.fieldErrors?.dedupeMode}>
          <select
            name="dedupeMode"
            value={dedupeMode}
            onChange={(e) => setDedupeMode(e.target.value as SettingsValues['dedupeMode'])}
            className="input"
          >
            <option value="never_repeat">Never message it again</option>
            <option value="cooldown">Wait a while, then allow it</option>
            <option value="off">Allow it — only my block list stops a send</option>
          </select>
        </Field>

        {dedupeMode === 'cooldown' ? (
          <Field
            label="Wait this many days before re-messaging"
            error={state?.fieldErrors?.cooldownDays}
          >
            <input
              name="cooldownDays"
              type="number"
              min={1}
              max={3650}
              defaultValue={values.cooldownDays}
              className="input"
            />
          </Field>
        ) : (
          <input type="hidden" name="cooldownDays" value={values.cooldownDays} />
        )}
      </Fieldset>

      <Fieldset
        legend="How many new people per day"
        hint="WhatsApp restricts accounts that message too many strangers within 24 hours. Leave the limit blank to use the safe limit your number has earned."
      >
        <Field
          label="My own limit (optional)"
          error={state?.fieldErrors?.newContactCap24h}
          hint="Only used if it is lower than your earned limit."
        >
          <input
            name="newContactCap24h"
            type="number"
            min={1}
            max={500}
            placeholder="Use earned limit"
            defaultValue={values.newContactCap24h ?? ''}
            className="input"
          />
        </Field>

        <Checkbox
          name="warmupEnabled"
          defaultChecked={values.warmupEnabled}
          label="Start slowly on a newly linked number"
          hint="Strongly recommended. A brand-new number sending at full speed is the most common way to get restricted."
        />
      </Fieldset>

      <Fieldset
        legend="Pace"
        hint="Messages go out at a random gap inside this range, then pause between batches, so the rhythm does not look automated."
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Min gap (seconds)" error={state?.fieldErrors?.minDelayMs}>
            <input
              name="minDelaySeconds"
              type="number"
              min={10}
              max={600}
              defaultValue={Math.round(values.minDelayMs / 1000)}
              className="input"
            />
          </Field>
          <Field label="Max gap (seconds)" error={state?.fieldErrors?.maxDelayMs}>
            <input
              name="maxDelaySeconds"
              type="number"
              min={10}
              max={1800}
              defaultValue={Math.round(values.maxDelayMs / 1000)}
              className="input"
            />
          </Field>
        </div>

        <Field
          label="Messages per batch"
          error={state?.fieldErrors?.batchSize}
          hint="A longer pause follows each batch."
        >
          <input
            name="batchSize"
            type="number"
            min={1}
            max={100}
            defaultValue={values.batchSize}
            className="input"
          />
        </Field>
      </Fieldset>

      <Fieldset
        legend="When to send"
        hint="Messages that arrive at 3am get reported. Nothing is sent outside these hours."
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" error={state?.fieldErrors?.sendWindowStartHour}>
            <select
              name="sendWindowStartHour"
              defaultValue={values.sendWindowStartHour}
              className="input"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Until" error={state?.fieldErrors?.sendWindowEndHour}>
            <select
              name="sendWindowEndHour"
              defaultValue={values.sendWindowEndHour}
              className="input"
            >
              {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Time zone" error={state?.fieldErrors?.timezone}>
          <select name="timezone" defaultValue={values.timezone} className="input">
            {[...new Set([values.timezone, ...TIMEZONES])].map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace('_', ' ')}
              </option>
            ))}
          </select>
        </Field>

        <Checkbox
          name="skipWeekends"
          defaultChecked={values.skipWeekends}
          label="Skip Saturdays and Sundays"
        />
      </Fieldset>

      <Fieldset
        legend="Imports"
        hint="Used when a number in your sheet has no country code."
      >
        <Field label="Default country code" error={state?.fieldErrors?.defaultCountry}>
          <input
            name="defaultCountry"
            maxLength={2}
            defaultValue={values.defaultCountry}
            className="input uppercase"
            placeholder="IN"
          />
        </Field>
      </Fieldset>

      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}

function formatHour(h: number): string {
  if (h === 0) return '12 am';
  if (h === 12) return '12 pm';
  if (h === 24) return 'midnight';
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

function Fieldset({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="card">
      <legend className="px-1 text-sm font-semibold">{legend}</legend>
      {hint ? <p className="hint mt-1 mb-4">{hint}</p> : null}
      <div className="space-y-4">{children}</div>
    </fieldset>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      {/* Implicit association: wrapping the control in the <label> avoids
          having to thread a generated id through every input. */}
      <label className="block">
        <span className="label">{label}</span>
        {children}
      </label>
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : hint ? (
        <p className="hint">{hint}</p>
      ) : null}
    </div>
  );
}

function Checkbox({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked: boolean;
}) {
  const id = useId();
  return (
    <div className="flex gap-3">
      <input
        id={id}
        name={name}
        type="checkbox"
        defaultChecked={defaultChecked}
        className="mt-1 size-5 shrink-0 rounded border-neutral-300 text-brand-600"
      />
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {hint ? <p className="hint">{hint}</p> : null}
      </div>
    </div>
  );
}

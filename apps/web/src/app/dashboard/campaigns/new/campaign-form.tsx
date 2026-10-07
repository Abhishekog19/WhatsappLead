'use client';

import { useActionState, useId, useMemo, useState } from 'react';
import { createCampaign, type CampaignResult } from '../actions';

/**
 * Campaign setup: a number, a list, a message.
 *
 * The estimate is the point of this screen. "347 contacts" means nothing on
 * its own; "about 7 days at your current pace" is what tells a user whether
 * their settings are what they actually want, and it is far cheaper to find
 * that out here than three days into a run.
 */

interface SessionOption {
  id: string;
  label: string;
  phoneE164: string | null;
  accountType: 'personal' | 'business';
}

interface ListOption {
  id: string;
  name: string;
  rowsImported: number;
  unmessaged: number;
}

interface MessageOption {
  id: string;
  name: string;
  variants: number;
}

interface Pacing {
  minDelayMs: number;
  maxDelayMs: number;
  batchSize: number;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
  timezone: string;
  dedupeMode: 'never_repeat' | 'cooldown' | 'off';
}

export function CampaignForm({
  sessions,
  lists,
  messages,
  pacing,
}: {
  sessions: SessionOption[];
  lists: ListOption[];
  messages: MessageOption[];
  pacing: Pacing | null;
}) {
  const [state, action, pending] = useActionState<CampaignResult | null, FormData>(
    createCampaign,
    null,
  );

  const [listId, setListId] = useState(lists[0]?.id ?? '');
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? '');
  const [cap, setCap] = useState('');

  const nameId = useId();
  const capId = useId();

  const list = lists.find((l) => l.id === listId);
  const session = sessions.find((s) => s.id === sessionId);

  // How many of the list will actually be sent to, given the dedupe setting.
  const willSend = useMemo(() => {
    if (!list) return 0;
    if (pacing?.dedupeMode === 'off') return list.rowsImported;
    return list.unmessaged;
  }, [list, pacing]);

  const estimate = useMemo(() => {
    if (!willSend || !session) return null;

    // Mirrors the worker's effectiveCap for the day-one warm-up case, which is
    // the conservative figure and the one a new user will actually hit.
    const tierCap = session.accountType === 'business' ? 40 : 30;
    const userCap = Number(cap) || null;
    const perDay = Math.max(1, Math.min(tierCap, userCap ?? tierCap));
    const days = Math.ceil(willSend / perDay);

    const avgDelayMs = pacing
      ? (pacing.minDelayMs + pacing.maxDelayMs) / 2
      : 40_000;
    const windowHours = pacing
      ? pacing.sendWindowEndHour - pacing.sendWindowStartHour
      : 9;

    return { perDay, days, avgDelaySec: Math.round(avgDelayMs / 1_000), windowHours };
  }, [willSend, session, cap, pacing]);

  return (
    <form action={action} className="space-y-6">
      {state && !state.ok ? (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {state.message}
        </p>
      ) : null}

      <div className="card space-y-4">
        <div>
          <label htmlFor={nameId} className="label">
            Campaign name
          </label>
          <input
            id={nameId}
            name="name"
            required
            maxLength={80}
            defaultValue={
              lists[0] ? `${lists[0].name} outreach` : 'My first campaign'
            }
            className="input"
          />
        </div>

        <div>
          <label htmlFor="sessionId" className="label">
            Send from
          </label>
          <select
            id="sessionId"
            name="sessionId"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            className="input"
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {s.phoneE164}
                {s.accountType === 'business' ? ' (Business)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="listId" className="label">
            Contact list
          </label>
          <select
            id="listId"
            name="listId"
            value={listId}
            onChange={(e) => setListId(e.target.value)}
            className="input"
          >
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} — {l.rowsImported.toLocaleString()} contacts
              </option>
            ))}
          </select>
          {list ? (
            <p className="hint">
              {pacing?.dedupeMode === 'off'
                ? `All ${list.rowsImported.toLocaleString()} will be messaged.`
                : `${list.unmessaged.toLocaleString()} have never been messaged. The other ${(
                    list.rowsImported - list.unmessaged
                  ).toLocaleString()} will be skipped automatically.`}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="templateId" className="label">
            Message
          </label>
          <select id="templateId" name="templateId" className="input">
            {messages.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.variants > 1 ? ` — ${m.variants} versions` : ''}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={capId} className="label">
            Limit for this campaign
          </label>
          <input
            id={capId}
            name="dailyCapOverride"
            type="number"
            inputMode="numeric"
            min={1}
            max={500}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            placeholder="Use my usual limit"
            className="input"
          />
          <p className="hint">
            New contacts per day, if you want this campaign to go slower than
            usual. It can lower the limit but never raise it above what the
            number has earned.
          </p>
        </div>
      </div>

      {estimate ? (
        <section className="card">
          <h2 className="text-sm font-semibold">What to expect</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Messages to send" value={willSend.toLocaleString()} />
            <Row label="Per day, to start" value={`up to ${estimate.perDay}`} />
            <Row
              label="Roughly"
              value={
                estimate.days <= 1
                  ? 'finishes today'
                  : `${estimate.days} days`
              }
            />
            <Row
              label="Pace"
              value={`a message every ~${estimate.avgDelaySec}s, in batches`}
            />
            <Row
              label="Sending hours"
              value={
                pacing
                  ? `${pacing.sendWindowStartHour}:00–${pacing.sendWindowEndHour}:00 ${pacing.timezone}`
                  : 'your configured window'
              }
            />
          </dl>
          <p className="hint">
            The daily limit rises over the first week as the number warms up, so
            this usually finishes sooner than the estimate.
          </p>
        </section>
      ) : null}

      <div className="card space-y-4">
        <label className="flex min-h-11 items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="startNow"
            defaultChecked
            className="mt-0.5 size-5 rounded border-neutral-300 text-brand-600"
          />
          <span>
            <span className="font-medium">Start sending straight away</span>
            <span className="hint block">
              Leave this off to review the campaign first. You can start it at
              any time, and pause it whenever you like.
            </span>
          </span>
        </label>

        <button
          type="submit"
          disabled={pending || willSend === 0}
          className="btn-primary w-full"
        >
          {pending ? 'Creating…' : 'Create campaign'}
        </button>

        {willSend === 0 && list ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            Everyone in this list has already been messaged. Import a new list,
            or change your dedupe setting if you mean to message them again.
          </p>
        ) : null}
      </div>
    </form>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-neutral-600 dark:text-neutral-400">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </div>
  );
}

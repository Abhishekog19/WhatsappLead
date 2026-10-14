'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The campaign's progress, updating as it sends.
 *
 * Seeded from server-rendered values so the first paint is correct with no
 * flash, then kept current over SSE. A campaign sends one message every 25–55
 * seconds with much longer pauses between batches, so the point is not
 * frequency — it is being able to tell "moving slowly" from "stopped", which a
 * static page cannot express.
 *
 * On a status change the whole page is refreshed rather than patched: status
 * drives the explanation text, the controls and the skip breakdown, all
 * rendered on the server, and keeping two copies of that logic in sync is not
 * worth the saved round trip.
 */

export interface ProgressSnapshot {
  status: string;
  totalTargets: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  replyCount: number;
  pauseReason: string | null;
  latest: { name: string | null; phoneE164: string; sentAt: string } | null;
}

export function LiveProgress({
  campaignId,
  initial,
  capLabel,
}: {
  campaignId: string;
  initial: ProgressSnapshot;
  capLabel: string | null;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [connected, setConnected] = useState(false);
  const router = useRouter();
  const statusRef = useRef(initial.status);

  const running = snapshot.status === 'running';

  useEffect(() => {
    // Only a running campaign changes on its own. Holding a stream open for a
    // draft or a finished one would be a connection per idle tab.
    if (!running) return;

    const source = new EventSource(`/api/campaigns/${campaignId}/stream`);

    source.addEventListener('progress', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as ProgressSnapshot;
      setSnapshot(data);
      setConnected(true);

      if (data.status !== statusRef.current) {
        statusRef.current = data.status;
        router.refresh();
      }
    });

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setConnected(false);
    };

    return () => source.close();
  }, [campaignId, running, router]);

  const done = snapshot.sentCount + snapshot.failedCount + snapshot.skippedCount;
  const pct =
    snapshot.totalTargets > 0 ? Math.round((done / snapshot.totalTargets) * 100) : 0;
  const remaining = Math.max(0, snapshot.totalTargets - done);

  return (
    <section className="card">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Progress
          {running ? (
            <span className="ml-2 inline-flex items-center gap-1.5 align-middle">
              <span
                aria-hidden
                className={`size-1.5 rounded-full ${
                  connected ? 'animate-pulse bg-brand-500' : 'bg-neutral-400'
                }`}
              />
              <span className="text-xs text-neutral-500">
                {connected ? 'live' : 'reconnecting'}
              </span>
            </span>
          ) : null}
        </p>
        <p className="text-sm font-semibold tabular-nums">{pct}%</p>
      </div>

      <div
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={snapshot.totalTargets}
        aria-label="Campaign progress"
        className="mt-2 h-2.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
      >
        <div
          className="h-full rounded-full bg-brand-500 transition-[width] duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* aria-live so a screen reader hears each send rather than having to
          re-read the page to discover one happened. */}
      <dl
        aria-live="polite"
        className="mt-4 grid grid-cols-2 gap-3 text-sm"
      >
        <Figure label="Sent" value={snapshot.sentCount} />
        <Figure label="Replies" value={snapshot.replyCount} />
        <Figure label="Remaining" value={remaining} />
        <Figure label="Skipped" value={snapshot.skippedCount} />
        {snapshot.failedCount > 0 ? (
          <Figure label="Failed" value={snapshot.failedCount} />
        ) : null}
        {capLabel ? <Figure label="Today's quota" text={capLabel} /> : null}
      </dl>

      {snapshot.latest ? (
        <p className="hint" aria-live="polite">
          Last sent to{' '}
          <span className="font-medium text-neutral-700 dark:text-neutral-300">
            {snapshot.latest.name ?? snapshot.latest.phoneE164}
          </span>{' '}
          <RelativeTime iso={snapshot.latest.sentAt} />
        </p>
      ) : null}
    </section>
  );
}

/**
 * "22s ago", ticking.
 *
 * Deliberately relative: on a page whose whole purpose is "is this still
 * moving", a timestamp that quietly ages is exactly the thing the reader is
 * trying to work out.
 */
function RelativeTime({ iso }: { iso: string }) {
  const [, force] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 5_000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1_000));
  const text =
    seconds < 60
      ? `${seconds}s ago`
      : seconds < 3_600
        ? `${Math.round(seconds / 60)}m ago`
        : `${Math.round(seconds / 3_600)}h ago`;

  return <time dateTime={iso}>{text}</time>;
}

function Figure({
  label,
  value,
  text,
}: {
  label: string;
  value?: number;
  text?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="mt-0.5 text-lg font-bold tabular-nums">
        {text ?? (value ?? 0).toLocaleString()}
      </dd>
    </div>
  );
}

'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  cancelCampaign,
  pauseCampaign,
  startCampaign,
  type CampaignResult,
} from '../actions';

/**
 * Start, pause and cancel.
 *
 * The counters stream over SSE in LiveProgress, so this only refreshes slowly
 * — the recent-activity list and the skip breakdown are rendered on the
 * server and would otherwise never catch up. A minute is frequent enough for
 * a list of sends that arrive at most every 25 seconds, and it keeps a phone
 * from re-fetching the page four times a minute for nothing.
 */
export function CampaignControls({
  campaignId,
  status,
  remaining,
}: {
  campaignId: string;
  status: string;
  remaining: number;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (status !== 'running') return;
    const timer = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(timer);
  }, [status, router]);

  function run(fn: () => Promise<CampaignResult>): void {
    startTransition(async () => {
      const result = await fn();
      setMessage({ ok: result.ok, text: result.message });
      setConfirmingCancel(false);
      if (result.ok) router.refresh();
    });
  }

  const finished =
    status === 'completed' || status === 'cancelled' || status === 'failed';

  return (
    <section className="space-y-3">
      {message ? (
        <p
          role="status"
          className={`rounded-xl p-3 text-sm ${
            message.ok
              ? 'border border-brand-200 bg-brand-50 text-brand-800 dark:border-brand-900 dark:bg-brand-950 dark:text-brand-200'
              : 'border border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200'
          }`}
        >
          {message.text}
        </p>
      ) : null}

      {finished ? null : (
        <div className="flex gap-2">
          {status === 'running' ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => pauseCampaign(campaignId))}
              className="btn-secondary flex-1"
            >
              {pending ? 'Working…' : 'Pause'}
            </button>
          ) : (
            <button
              type="button"
              disabled={pending || remaining === 0}
              onClick={() => run(() => startCampaign(campaignId))}
              className="btn-primary flex-1"
            >
              {pending
                ? 'Working…'
                : status === 'paused'
                  ? 'Resume'
                  : 'Start sending'}
            </button>
          )}

          {confirmingCancel ? (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => cancelCampaign(campaignId))}
                className="btn flex-1 bg-red-600 text-white hover:bg-red-700"
              >
                {pending ? '…' : `Drop ${remaining}`}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingCancel(false)}
                className="btn-secondary"
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingCancel(true)}
              className="btn-secondary"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {confirmingCancel ? (
        <p className="hint">
          Cancelling drops the {remaining.toLocaleString()} messages still
          queued. Pause instead if you might want to continue later.
        </p>
      ) : null}

      {status === 'running' ? (
        <p className="hint">
          You can close this page — sending carries on without it.
        </p>
      ) : null}
    </section>
  );
}

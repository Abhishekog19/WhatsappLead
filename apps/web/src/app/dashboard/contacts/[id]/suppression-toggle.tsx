'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { suppressContact, unsuppressContact } from './actions';

/**
 * Add or remove one number from the do-not-contact list.
 *
 * Adding needs no confirmation — it is the cautious direction, and making it
 * hesitant would discourage the behaviour worth encouraging. Removing does ask,
 * because it puts someone back in the sending pool.
 */
export function SuppressionToggle({
  contactId,
  suppressed,
  isOptOut,
}: {
  contactId: string;
  suppressed: boolean;
  isOptOut: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();

  function run(fn: () => Promise<{ ok: boolean; message: string }>): void {
    startTransition(async () => {
      const result = await fn();
      setMessage({ ok: result.ok, text: result.message });
      setConfirming(false);
      if (result.ok) router.refresh();
    });
  }

  if (isOptOut) {
    return (
      <section className="card">
        <h2 className="text-sm font-semibold">Do not contact</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          This person replied asking to stop. That cannot be undone here — it is
          their choice, not a setting.
        </p>
      </section>
    );
  }

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="text-sm font-semibold">
          {suppressed ? 'On your do-not-contact list' : 'Do not contact'}
        </h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          {suppressed
            ? 'No campaign will include this number.'
            : 'Blocks this number from every campaign, regardless of your dedupe setting.'}
        </p>
      </div>

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

      {suppressed ? (
        confirming ? (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => unsuppressContact(contactId))}
              className="btn-primary flex-1"
            >
              {pending ? 'Working…' : 'Yes, allow again'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="btn-secondary flex-1"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="btn-secondary w-full"
          >
            Allow messages again
          </button>
        )
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => suppressContact(contactId))}
          className="btn w-full bg-red-600 text-white hover:bg-red-700"
        >
          {pending ? 'Working…' : 'Never message this number'}
        </button>
      )}
    </section>
  );
}

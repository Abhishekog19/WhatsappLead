'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { addNumber, retryPairing, unlinkNumber, type ActionResult } from './actions';

/**
 * The linking experience.
 *
 * Built around the fact that most people have exactly one phone. WhatsApp can
 * link a device by phone number instead of QR: the server gets an 8-character
 * code, and the user types it into WhatsApp on the same phone they are
 * browsing from. No camera, no second screen.
 *
 * The code has a short life, so the countdown and the "get a new code" button
 * are not decoration — they are the difference between a flow that works and
 * one where the user stares at a dead code.
 */

export interface ExistingSession {
  id: string;
  label: string;
  phoneE164: string | null;
  status: string;
  accountType: 'personal' | 'business';
  lastError: string | null;
  linkedAt: string | null;
}

export function NumbersManager({
  sessions,
  defaultCountry,
}: {
  sessions: ExistingSession[];
  defaultCountry: string;
}) {
  // A session mid-handshake is what the watcher attaches to. Picking it up
  // from the server-rendered list means a page refresh resumes the flow
  // instead of losing it.
  const inProgress = sessions.find(
    (s) => s.status === 'pending' || s.status === 'pairing',
  );
  const [watching, setWatching] = useState<string | null>(inProgress?.id ?? null);
  const [adding, setAdding] = useState(sessions.length === 0);

  return (
    <div className="space-y-6">
      {watching ? (
        <PairingWatcher
          sessionId={watching}
          onDone={() => setWatching(null)}
          onCancel={() => setWatching(null)}
        />
      ) : null}

      {sessions.length > 0 ? (
        <section aria-labelledby="linked-heading" className="space-y-3">
          <h2 id="linked-heading" className="text-sm font-semibold text-neutral-500">
            Linked numbers
          </h2>
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              onRetry={() => setWatching(s.id)}
            />
          ))}
        </section>
      ) : null}

      {adding || sessions.length === 0 ? (
        <AddNumberForm
          defaultCountry={defaultCountry}
          onStarted={(id) => {
            setWatching(id);
            setAdding(false);
          }}
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="btn-secondary w-full">
          Link another number
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function AddNumberForm({
  defaultCountry,
  onStarted,
}: {
  defaultCountry: string;
  onStarted: (sessionId: string) => void;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    addNumber,
    null,
  );
  const labelId = useId();
  const phoneId = useId();
  const typeId = useId();

  useEffect(() => {
    if (state?.ok && state.sessionId) onStarted(state.sessionId);
  }, [state, onStarted]);

  return (
    <form action={action} className="card space-y-4">
      <div>
        <h2 className="font-semibold">Link a WhatsApp number</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Use the number on the phone you have with you. You will type an
          8-character code into WhatsApp — there is no QR code to scan.
        </p>
      </div>

      {state && !state.ok ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {state.message}
        </p>
      ) : null}

      <input type="hidden" name="defaultCountry" value={defaultCountry} />

      <div>
        <label htmlFor={labelId} className="label">
          Name this number
        </label>
        <input
          id={labelId}
          name="label"
          required
          maxLength={60}
          defaultValue="My WhatsApp"
          className="input"
          autoComplete="off"
        />
        <p className="hint">Just for you — e.g. &ldquo;Work number&rdquo;.</p>
        {state?.fieldErrors?.label ? <FieldError>{state.fieldErrors.label}</FieldError> : null}
      </div>

      <div>
        <label htmlFor={phoneId} className="label">
          WhatsApp number
        </label>
        <input
          id={phoneId}
          name="phone"
          required
          // `tel` gets the numeric keypad; the + has to be typeable, so not
          // inputMode="numeric".
          type="tel"
          placeholder="+91 98765 43210"
          className="input"
          autoComplete="tel"
        />
        <p className="hint">Include the country code.</p>
        {state?.fieldErrors?.phone ? <FieldError>{state.fieldErrors.phone}</FieldError> : null}
      </div>

      <div>
        <label htmlFor={typeId} className="label">
          Account type
        </label>
        <select id={typeId} name="accountType" className="input" defaultValue="personal">
          <option value="personal">Personal WhatsApp</option>
          <option value="business">WhatsApp Business</option>
        </select>
        <p className="hint">
          Business accounts are allowed a higher daily limit, so this affects how
          fast you can send.
        </p>
      </div>

      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? 'Starting…' : 'Get my pairing code'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------

interface Snapshot {
  status: string;
  phoneE164: string | null;
  pairingCode: string | null;
  pairingCodeExpiresAt: string | null;
  qrPayload: string | null;
  lastError: string | null;
}

function PairingWatcher({
  sessionId,
  onDone,
  onCancel,
}: {
  sessionId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [streamFailed, setStreamFailed] = useState(false);
  const router = useRouter();
  const doneRef = useRef(false);

  useEffect(() => {
    const source = new EventSource(`/api/sessions/${sessionId}/stream`);

    source.addEventListener('status', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as Snapshot;
      setSnapshot(data);

      if (data.status === 'connected' && !doneRef.current) {
        doneRef.current = true;
        // Let the success state show for a moment before the page reloads with
        // the number in the linked list.
        setTimeout(() => {
          router.refresh();
          onDone();
        }, 1_800);
      }
    });

    source.onerror = () => {
      // EventSource retries on its own; this only surfaces a hint after it has
      // clearly given up, so a brief blip does not flash a scary message.
      if (source.readyState === EventSource.CLOSED) setStreamFailed(true);
    };

    return () => source.close();
  }, [sessionId, router, onDone]);

  const status = snapshot?.status ?? 'pending';

  if (status === 'connected') {
    return (
      <div className="card border-brand-300 bg-brand-50 dark:border-brand-800 dark:bg-brand-950">
        <p className="font-semibold text-brand-900 dark:text-brand-100">
          Connected.
        </p>
        <p className="mt-1 text-sm text-brand-800 dark:text-brand-200">
          {snapshot?.phoneE164 ?? 'Your number'} is linked and ready to send.
        </p>
      </div>
    );
  }

  if (status === 'banned') {
    return (
      <Problem
        title="WhatsApp rejected this number"
        detail={snapshot?.lastError ?? 'The account cannot be linked.'}
        onDismiss={onCancel}
      />
    );
  }

  if (status === 'disconnected' || status === 'logged_out') {
    return (
      <Problem
        title="Linking did not complete"
        detail={
          snapshot?.lastError ??
          'The code was not entered in time, or WhatsApp closed the connection.'
        }
        onDismiss={onCancel}
        sessionId={sessionId}
      />
    );
  }

  return (
    <div className="card space-y-4">
      {snapshot?.pairingCode ? (
        <PairingCode
          code={snapshot.pairingCode}
          expiresAt={snapshot.pairingCodeExpiresAt}
          sessionId={sessionId}
        />
      ) : (
        <div className="flex items-center gap-3">
          <Spinner />
          <div>
            <p className="font-medium">Getting your code from WhatsApp…</p>
            <p className="hint">This usually takes a few seconds.</p>
          </div>
        </div>
      )}

      {streamFailed ? (
        <p className="hint">
          Live updates stopped.{' '}
          <button
            type="button"
            onClick={() => router.refresh()}
            className="underline underline-offset-2"
          >
            Refresh
          </button>{' '}
          to see the current status.
        </p>
      ) : null}

      <button type="button" onClick={onCancel} className="btn-secondary w-full">
        Cancel
      </button>
    </div>
  );
}

function PairingCode({
  code,
  expiresAt,
  sessionId,
}: {
  code: string;
  expiresAt: string | null;
  sessionId: string;
}) {
  const remaining = useCountdown(expiresAt);
  const expired = remaining !== null && remaining <= 0;
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const router = useRouter();

  async function copy(): Promise<void> {
    try {
      // Without the dash: this is going into WhatsApp's own input, which
      // expects the eight characters only.
      await navigator.clipboard.writeText(code.replace('-', ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access is denied in some mobile browsers; the code is on
      // screen to be typed anyway.
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="font-semibold">Type this code into WhatsApp</p>
        <p
          className="mt-2 font-mono text-3xl font-bold tracking-[0.2em] tabular-nums"
          aria-label={`Pairing code ${code.split('').join(' ')}`}
        >
          {expired ? '––––––––' : code}
        </p>
      </div>

      {expired ? (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
          This code has expired. Get a new one to try again.
        </p>
      ) : (
        <>
          <ol className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
            <Step n={1}>Open WhatsApp on this phone</Step>
            <Step n={2}>
              Go to <strong>Settings → Linked Devices</strong>
            </Step>
            <Step n={3}>
              Tap <strong>Link a Device</strong>, then{' '}
              <strong>Link with phone number instead</strong>
            </Step>
            <Step n={4}>Enter the code above</Step>
          </ol>

          <p className="hint tabular-nums" role="timer">
            {remaining === null
              ? 'Enter it soon — the code is short-lived.'
              : `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`}
          </p>
        </>
      )}

      <div className="flex gap-2">
        {!expired ? (
          <button type="button" onClick={copy} className="btn-secondary flex-1">
            {copied ? 'Copied' : 'Copy code'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            await retryPairing(sessionId);
            router.refresh();
            setRetrying(false);
          }}
          className={expired ? 'btn-primary flex-1' : 'btn-secondary flex-1'}
        >
          {retrying ? 'Working…' : 'New code'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SessionRow({
  session,
  onRetry,
}: {
  session: ExistingSession;
  onRetry: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();

  const needsAttention =
    session.status === 'logged_out' ||
    session.status === 'banned' ||
    session.status === 'pending';

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{session.label}</p>
          <p className="truncate text-sm text-neutral-500">
            {session.phoneE164 ?? 'No number yet'}
            {session.accountType === 'business' ? ' · Business' : ''}
          </p>
        </div>
        <StatusPill status={session.status} />
      </div>

      {session.lastError && needsAttention ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">{session.lastError}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        {needsAttention ? (
          <button type="button" onClick={onRetry} className="btn-secondary flex-1">
            Link again
          </button>
        ) : null}

        {confirming ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                const result = await unlinkNumber(session.id);
                if (!result.ok) setError(result.message);
                setBusy(false);
                setConfirming(false);
                router.refresh();
              }}
              className="btn flex-1 bg-red-600 text-white hover:bg-red-700"
            >
              {busy ? 'Unlinking…' : 'Yes, unlink'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="btn-secondary flex-1"
            >
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="btn-secondary flex-1"
          >
            Unlink
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Seconds left until `iso`, or null when there is no deadline. */
function useCountdown(iso: string | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!iso) {
      setRemaining(null);
      return;
    }
    const target = new Date(iso).getTime();
    const tick = (): void =>
      setRemaining(Math.max(0, Math.round((target - Date.now()) / 1_000)));
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [iso]);

  return remaining;
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold dark:bg-neutral-800">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

function Problem({
  title,
  detail,
  onDismiss,
  sessionId,
}: {
  title: string;
  detail: string;
  onDismiss: () => void;
  sessionId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  return (
    <div className="card border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950">
      <p className="font-semibold text-amber-900 dark:text-amber-100">{title}</p>
      <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">{detail}</p>
      <div className="mt-4 flex gap-2">
        {sessionId ? (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await retryPairing(sessionId);
              router.refresh();
              setBusy(false);
            }}
            className="btn-primary flex-1"
          >
            {busy ? 'Working…' : 'Try again'}
          </button>
        ) : null}
        <button type="button" onClick={onDismiss} className="btn-secondary flex-1">
          Close
        </button>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="size-5 shrink-0 animate-spin rounded-full border-2 border-neutral-300 border-t-brand-600 dark:border-neutral-700 dark:border-t-brand-400"
    />
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-300">
      {children}
    </p>
  );
}

const PILL: Record<string, string> = {
  connected: 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200',
  pairing: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  throttled: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  disconnected: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  logged_out: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  banned: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

function StatusPill({ status }: { status: string }) {
  const LABEL: Record<string, string> = {
    connected: 'Connected',
    pairing: 'Waiting for code',
    pending: 'Starting',
    throttled: 'Slowed by WhatsApp',
    disconnected: 'Reconnecting',
    logged_out: 'Unlinked',
    banned: 'Blocked',
  };
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${PILL[status] ?? PILL.disconnected}`}
    >
      {LABEL[status] ?? status}
    </span>
  );
}

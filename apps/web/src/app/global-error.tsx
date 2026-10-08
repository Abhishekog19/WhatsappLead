'use client';

/**
 * Last-resort error boundary. The message from the thrown error is deliberately
 * not shown — it can carry database detail — but the digest is, so a user can
 * quote it in a support request and it can be matched against the server log.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6 font-sans">
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-bold">Something went wrong</h1>
          <p className="mt-2 text-sm text-neutral-600">
            The page failed to load. Nothing you were sending has been lost.
          </p>
          {error.digest ? (
            <p className="mt-3 font-mono text-xs text-neutral-400">
              Reference: {error.digest}
            </p>
          ) : null}
          <button type="button" onClick={reset} className="btn-primary mt-6 w-full">
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}

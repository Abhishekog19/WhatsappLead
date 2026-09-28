import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { signIn } from '@/server/auth';
import { currentUser } from '@/server/session';

export const metadata: Metadata = { title: 'Sign in' };

const ERRORS: Record<string, string> = {
  AccessDenied:
    'That account is not allowed to sign in. If you think this is a mistake, get in touch.',
  Configuration:
    'Sign-in is misconfigured on the server. Nothing you did wrong — try again shortly.',
  OAuthAccountNotLinked:
    'That email is already registered with a different sign-in method.',
  Verification: 'That sign-in link has expired. Please try again.',
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  if (await currentUser()) redirect('/dashboard');

  const { error, next } = await searchParams;
  const message = error ? (ERRORS[error] ?? 'Something went wrong signing in.') : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5 py-10">
      <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        We use your Google account so there is no extra password to remember.
      </p>

      {message ? (
        <p
          role="alert"
          className="mt-6 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {message}
        </p>
      ) : null}

      <form
        className="mt-8"
        action={async () => {
          'use server';
          // redirectTo is validated by Auth.js against the configured host, so
          // a crafted ?next= cannot bounce the user off-site.
          await signIn('google', { redirectTo: next ?? '/dashboard' });
        }}
      >
        <button type="submit" className="btn-secondary w-full">
          <GoogleMark />
          Continue with Google
        </button>
      </form>

      <p className="mt-8 text-xs text-neutral-500">
        By continuing you agree to send only messages you have a lawful basis to
        send, and to honour opt-out requests promptly.
      </p>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-5">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.62 0 3.07.56 4.21 1.65l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 6.68 9.14 4.75 12 4.75Z"
      />
    </svg>
  );
}

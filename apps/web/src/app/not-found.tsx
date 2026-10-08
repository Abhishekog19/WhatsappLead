import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center px-5 text-center">
      <h1 className="text-xl font-bold">Page not found</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        That link does not point anywhere.
      </p>
      <Link href="/dashboard" className="btn-primary mt-6 w-full">
        Back to the dashboard
      </Link>
    </main>
  );
}

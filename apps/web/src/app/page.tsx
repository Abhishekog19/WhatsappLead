import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/server/session';

const STEPS = [
  {
    title: 'Link WhatsApp from your phone',
    body: 'No second device and no camera needed — WhatsApp shows you an 8-character code to type into Linked Devices.',
  },
  {
    title: 'Upload your contact sheet',
    body: 'Drop in an Excel or CSV file. Numbers are cleaned up, duplicates are folded together, and anything unusable is listed so you can fix it.',
  },
  {
    title: 'Write one message, send hundreds',
    body: 'Use {{Name}} and other columns from your sheet. Sending runs in the cloud at a human pace, so you can close the tab.',
  },
];

export default async function HomePage() {
  const user = await currentUser();
  if (user) redirect('/dashboard');

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col px-5 py-10">
      <header className="mb-10">
        <p className="text-sm font-semibold text-brand-600">WhatsApp Outreach</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-balance">
          Reach your leads on WhatsApp, without leaving a laptop running.
        </h1>
        <p className="mt-4 text-neutral-600 dark:text-neutral-400">
          Link your number once, upload a sheet, and let it send at a safe pace
          from the cloud. Everything works from your phone.
        </p>
      </header>

      <Link href="/signin" className="btn-primary w-full">
        Get started — it&rsquo;s free
      </Link>

      <ol className="mt-12 space-y-6">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-4">
            <span
              aria-hidden
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700"
            >
              {i + 1}
            </span>
            <div>
              <h2 className="font-semibold">{step.title}</h2>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {step.body}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <section className="card mt-12">
        <h2 className="font-semibold">Built to keep your number safe</h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          WhatsApp limits how many new people you can message in a day. New
          numbers start slow and earn a higher limit over time, and sending
          pauses itself the moment WhatsApp signals it is unhappy.
        </p>
      </section>

      <footer className="mt-auto pt-12 text-xs text-neutral-500">
        <p>
          You are responsible for having a lawful basis to contact the people on
          your list, and for honouring opt-outs. This tool is not affiliated
          with or endorsed by WhatsApp or Meta.
        </p>
      </footer>
    </main>
  );
}

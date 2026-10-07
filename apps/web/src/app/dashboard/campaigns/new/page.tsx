import type { Metadata } from 'next';
import Link from 'next/link';
import { and, campaigns, desc, eq, settings } from '@wa/db';
import { queryAsUser } from '@/server/session';
import { loadCampaignOptions } from '../actions';
import { CampaignForm } from './campaign-form';

export const metadata: Metadata = { title: 'New campaign' };

export default async function NewCampaignPage() {
  const [options, prefs] = await Promise.all([
    loadCampaignOptions(),
    queryAsUser(async (tx, userId) => {
      const rows = await tx
        .select({
          minDelayMs: settings.minDelayMs,
          maxDelayMs: settings.maxDelayMs,
          batchSize: settings.batchSize,
          sendWindowStartHour: settings.sendWindowStartHour,
          sendWindowEndHour: settings.sendWindowEndHour,
          timezone: settings.timezone,
          dedupeMode: settings.dedupeMode,
        })
        .from(settings)
        .where(eq(settings.userId, userId))
        .limit(1);

      const running = await tx
        .select({ id: campaigns.id, name: campaigns.name })
        .from(campaigns)
        .where(and(eq(campaigns.userId, userId), eq(campaigns.status, 'running')))
        .orderBy(desc(campaigns.startedAt))
        .limit(1);

      return { prefs: rows[0] ?? null, running: running[0] ?? null };
    }),
  ]);

  const connected = options.sessions.filter((s) => s.status === 'connected');
  const usableLists = options.lists.filter((l) => l.rowsImported > 0);
  const usableMessages = options.messages.filter((m) => m.variants > 0);

  const blockers: { label: string; href: string; cta: string }[] = [];
  if (connected.length === 0) {
    blockers.push({
      label:
        options.sessions.length === 0
          ? 'You have not linked a WhatsApp number yet.'
          : 'None of your numbers are connected right now.',
      href: '/dashboard/settings/numbers',
      cta: 'Link WhatsApp',
    });
  }
  if (usableLists.length === 0) {
    blockers.push({
      label: 'You have no contacts to send to.',
      href: '/dashboard/contacts/import',
      cta: 'Import contacts',
    });
  }
  if (usableMessages.length === 0) {
    blockers.push({
      label: 'You have not written a message yet.',
      href: '/dashboard/templates',
      cta: 'Write a message',
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/campaigns" className="hint underline underline-offset-2">
          ← Campaigns
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">New campaign</h1>
      </div>

      {blockers.length > 0 ? (
        <div className="space-y-3">
          {blockers.map((b) => (
            <div key={b.href} className="card">
              <p className="text-sm">{b.label}</p>
              <Link href={b.href} className="btn-primary mt-3 w-full">
                {b.cta}
              </Link>
            </div>
          ))}
        </div>
      ) : (
        <>
          {prefs.running ? (
            <div className="card border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950">
              <p className="text-sm text-amber-900 dark:text-amber-100">
                <Link
                  href={`/dashboard/campaigns/${prefs.running.id}`}
                  className="font-medium underline underline-offset-2"
                >
                  {prefs.running.name}
                </Link>{' '}
                is already running. Both will share the same daily limit, so
                starting a second one does not send more — it just splits the
                budget.
              </p>
            </div>
          ) : null}

          <CampaignForm
            sessions={connected}
            lists={usableLists}
            messages={usableMessages}
            pacing={prefs.prefs}
          />
        </>
      )}
    </div>
  );
}

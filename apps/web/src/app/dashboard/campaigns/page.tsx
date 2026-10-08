import type { Metadata } from 'next';
import Link from 'next/link';
import { and, campaigns, contactLists, desc, eq, templates, waSessions } from '@wa/db';
import { queryAsUser } from '@/server/session';

export const metadata: Metadata = { title: 'Campaigns' };

export default async function CampaignsPage() {
  const rows = await queryAsUser(async (tx, userId) =>
    tx
      .select({
        id: campaigns.id,
        name: campaigns.name,
        status: campaigns.status,
        totalTargets: campaigns.totalTargets,
        sentCount: campaigns.sentCount,
        failedCount: campaigns.failedCount,
        skippedCount: campaigns.skippedCount,
        replyCount: campaigns.replyCount,
        startedAt: campaigns.startedAt,
        pauseReason: campaigns.pauseReason,
        listName: contactLists.name,
        templateName: templates.name,
        sessionLabel: waSessions.label,
      })
      .from(campaigns)
      .leftJoin(contactLists, eq(contactLists.id, campaigns.listId))
      .leftJoin(templates, eq(templates.id, campaigns.templateId))
      .leftJoin(waSessions, eq(waSessions.id, campaigns.sessionId))
      .where(eq(campaigns.userId, userId))
      .orderBy(desc(campaigns.createdAt))
      .limit(50),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Campaigns</h1>
        <Link href="/dashboard/campaigns/new" className="btn-primary shrink-0">
          New
        </Link>
      </div>

      {rows.length === 0 ? (
        <section className="card">
          <h2 className="font-semibold">No campaigns yet</h2>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            A campaign pairs a contact list with a message and sends it at a
            human pace. It keeps going while your phone is in your pocket, and
            you can pause it from here at any time.
          </p>
          <Link href="/dashboard/campaigns/new" className="btn-primary mt-4 w-full">
            Create a campaign
          </Link>
        </section>
      ) : (
        <ul className="space-y-3">
          {rows.map((c) => {
            const done = c.sentCount + c.failedCount + c.skippedCount;
            const pct =
              c.totalTargets > 0 ? Math.round((done / c.totalTargets) * 100) : 0;

            return (
              <li key={c.id}>
                <Link href={`/dashboard/campaigns/${c.id}`} className="card block">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.name}</p>
                      <p className="truncate text-xs text-neutral-500">
                        {[c.listName, c.templateName, c.sessionLabel]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <StatusPill status={c.status} />
                  </div>

                  <div
                    role="progressbar"
                    aria-valuenow={done}
                    aria-valuemin={0}
                    aria-valuemax={c.totalTargets}
                    aria-label={`${c.name} progress`}
                    className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
                  >
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  <p className="hint tabular-nums">
                    {c.sentCount.toLocaleString()} sent
                    {c.replyCount > 0 ? ` · ${c.replyCount} replied` : ''}
                    {c.skippedCount > 0 ? ` · ${c.skippedCount} skipped` : ''}
                    {c.failedCount > 0 ? ` · ${c.failedCount} failed` : ''}
                    {' of '}
                    {c.totalTargets.toLocaleString()}
                  </p>

                  {c.status === 'paused' && c.pauseReason ? (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                      {c.pauseReason}
                    </p>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const PILL: Record<string, string> = {
  running: 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200',
  completed: 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200',
  scheduled: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  draft: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  cancelled: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

const LABEL: Record<string, string> = {
  running: 'Sending',
  completed: 'Done',
  scheduled: 'Scheduled',
  paused: 'Paused',
  draft: 'Not started',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${PILL[status] ?? PILL.draft}`}
    >
      {LABEL[status] ?? status}
    </span>
  );
}

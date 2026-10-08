import type { Metadata } from 'next';
import Link from 'next/link';
import { and, count, eq, gt, sql, waSessions, campaigns, contacts } from '@wa/db';
import { effectiveCap, ROLLING_WINDOW_MS, type AccountType, type Tier } from '@wa/core';
import { queryAsUser } from '@/server/session';
import { env } from '@/server/context';

export const metadata: Metadata = { title: 'Home' };

/**
 * The dashboard's job on a phone is to answer three questions at a glance:
 * is my number connected, how much of today's quota is left, and what is
 * running right now.
 */
export default async function DashboardPage() {
  const data = await queryAsUser(async (tx, userId) => {
    const [sessions, activeCampaigns, contactCount] = await Promise.all([
      tx
        .select()
        .from(waSessions)
        .where(and(eq(waSessions.userId, userId), sql`${waSessions.deletedAt} is null`)),
      tx
        .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status, sentCount: campaigns.sentCount, totalTargets: campaigns.totalTargets })
        .from(campaigns)
        .where(and(eq(campaigns.userId, userId), sql`${campaigns.status} in ('running','scheduled','paused')`))
        .limit(5),
      tx
        .select({ n: count() })
        .from(contacts)
        .where(eq(contacts.userId, userId)),
    ]);

    // Used quota per linked number, from the rolling-window ledger.
    const since = new Date(Date.now() - ROLLING_WINDOW_MS);
    const used = sessions.length
      ? await tx.execute(sql`
          select session_id, count(*)::int as n
            from new_contact_sends
           where user_id = ${userId} and sent_at > ${since}
           group by session_id
        `)
      : [];

    const usedBySession = new Map<string, number>(
      (used as unknown as Array<{ session_id: string; n: number }>).map((r) => [
        r.session_id,
        r.n,
      ]),
    );

    return {
      sessions,
      activeCampaigns,
      contactCount: contactCount[0]?.n ?? 0,
      usedBySession,
    };
  });

  const platformCeiling = env().PLATFORM_MAX_NEW_CONTACTS_24H;
  const connected = data.sessions.filter((s) => s.status === 'connected');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Home</h1>

      {data.sessions.length === 0 ? (
        <EmptyState />
      ) : (
        <section aria-labelledby="numbers-heading" className="space-y-3">
          <h2 id="numbers-heading" className="text-sm font-semibold text-neutral-500">
            Your WhatsApp numbers
          </h2>
          {data.sessions.map((s) => {
            const daysSinceLink = s.linkedAt
              ? Math.max(1, Math.ceil((Date.now() - s.linkedAt.getTime()) / 86_400_000))
              : 1;
            const cap = effectiveCap({
              accountType: s.accountType as AccountType,
              tier: s.tier as Tier,
              daysSinceLink,
              warmupEnabled: true,
              platformCeiling,
            });
            return (
              <NumberCard
                key={s.id}
                label={s.label}
                phone={s.phoneE164}
                status={s.status}
                used={data.usedBySession.get(s.id) ?? 0}
                cap={cap}
                throttledUntil={s.throttledUntil}
              />
            );
          })}
          <Link href="/dashboard/settings/numbers" className="btn-secondary w-full">
            Link another number
          </Link>
        </section>
      )}

      <section className="grid grid-cols-2 gap-3">
        <Stat label="Contacts" value={data.contactCount.toLocaleString()} />
        <Stat label="Connected numbers" value={String(connected.length)} />
      </section>

      <section aria-labelledby="campaigns-heading" className="space-y-3">
        <h2 id="campaigns-heading" className="text-sm font-semibold text-neutral-500">
          Active campaigns
        </h2>
        {data.activeCampaigns.length === 0 ? (
          <p className="card text-sm text-neutral-500">
            Nothing running.{' '}
            <Link href="/dashboard/campaigns/new" className="text-brand-600 underline">
              Start a campaign
            </Link>
            .
          </p>
        ) : (
          data.activeCampaigns.map((c) => (
            <Link key={c.id} href={`/dashboard/campaigns/${c.id}`} className="card block">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-medium">{c.name}</span>
                <StatusPill status={c.status} />
              </div>
              <Progress sent={c.sentCount} total={c.totalTargets} />
            </Link>
          ))
        )}
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <section className="card">
      <h2 className="font-semibold">Link your WhatsApp to get started</h2>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        You will get an 8-character code to type into WhatsApp on this phone. No
        QR code to scan, so one phone is all you need.
      </p>
      <Link href="/dashboard/settings/numbers" className="btn-primary mt-4 w-full">
        Link WhatsApp
      </Link>
    </section>
  );
}

function NumberCard({
  label,
  phone,
  status,
  used,
  cap,
  throttledUntil,
}: {
  label: string;
  phone: string | null;
  status: string;
  used: number;
  cap: number;
  throttledUntil: Date | null;
}) {
  const remaining = Math.max(0, cap - used);
  const holding = throttledUntil && throttledUntil.getTime() > Date.now();

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{label}</p>
          <p className="truncate text-sm text-neutral-500">{phone ?? 'Not linked yet'}</p>
        </div>
        <StatusPill status={status} />
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">
            New contacts, last 24h
          </span>
          <span className="font-semibold tabular-nums">
            {used} / {cap}
          </span>
        </div>
        <div
          role="progressbar"
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={cap}
          aria-label="New contacts used in the last 24 hours"
          className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
        >
          <div
            className={`h-full rounded-full ${used / cap > 0.85 ? 'bg-amber-500' : 'bg-brand-500'}`}
            style={{ width: `${Math.min(100, (used / Math.max(1, cap)) * 100)}%` }}
          />
        </div>
        <p className="hint">
          {holding
            ? `Paused by WhatsApp until ${throttledUntil.toLocaleString()}.`
            : `${remaining} more new ${remaining === 1 ? 'person' : 'people'} can be messaged right now.`}
        </p>
      </div>
    </div>
  );
}

const PILL: Record<string, string> = {
  connected: 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200',
  running: 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200',
  scheduled: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  pairing: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  throttled: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  disconnected: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  logged_out: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  banned: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${PILL[status] ?? PILL.disconnected}`}
    >
      {status.replace('_', ' ')}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <p className="text-sm text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function Progress({ sent, total }: { sent: number; total: number }) {
  const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
  return (
    <>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
        <div className="h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="hint tabular-nums">
        {sent} of {total} sent
      </p>
    </>
  );
}

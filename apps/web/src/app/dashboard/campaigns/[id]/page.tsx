import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  and,
  campaigns,
  campaignTargets,
  contactLists,
  contacts,
  desc,
  eq,
  sql,
  templates,
  waSessions,
} from '@wa/db';
import {
  ROLLING_WINDOW_MS,
  effectiveCap,
  formatForDisplay,
  isWithinSendWindow,
  nextWindowOpensAt,
} from '@wa/core';
import { settings } from '@wa/db';
import { queryAsUser } from '@/server/session';
import { env } from '@/server/context';
import { CampaignControls } from './campaign-controls';

export const metadata: Metadata = { title: 'Campaign' };

/**
 * One campaign's progress and transcript.
 *
 * The "why is nothing happening" question is the one this page has to answer
 * well. A running campaign that is quiet is normal — it is between messages,
 * between batches, outside sending hours, or out of quota for the day — and
 * each of those has a different answer, so they are stated explicitly rather
 * than left as a spinner.
 */
export default async function CampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const data = await queryAsUser(async (tx, userId) => {
    const rows = await tx
      .select({
        campaign: campaigns,
        listName: contactLists.name,
        templateName: templates.name,
        templateId: templates.id,
        sessionLabel: waSessions.label,
        sessionPhone: waSessions.phoneE164,
        sessionStatus: waSessions.status,
        sessionId: waSessions.id,
        accountType: waSessions.accountType,
        tier: waSessions.tier,
        linkedAt: waSessions.linkedAt,
        throttledUntil: waSessions.throttledUntil,
      })
      .from(campaigns)
      .leftJoin(contactLists, eq(contactLists.id, campaigns.listId))
      .leftJoin(templates, eq(templates.id, campaigns.templateId))
      .leftJoin(waSessions, eq(waSessions.id, campaigns.sessionId))
      .where(and(eq(campaigns.id, id), eq(campaigns.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const [recent, skipBreakdown, prefs, usedRows] = await Promise.all([
      tx
        .select({
          targetId: campaignTargets.id,
          status: campaignTargets.status,
          skipReason: campaignTargets.skipReason,
          renderedBody: campaignTargets.renderedBody,
          sentAt: campaignTargets.sentAt,
          lastError: campaignTargets.lastError,
          contactId: contacts.id,
          contactName: contacts.name,
          contactPhone: contacts.phoneE164,
          repliedAt: contacts.lastRepliedAt,
        })
        .from(campaignTargets)
        .innerJoin(contacts, eq(contacts.id, campaignTargets.contactId))
        .where(eq(campaignTargets.campaignId, id))
        .orderBy(
          desc(sql`coalesce(${campaignTargets.sentAt}, ${campaignTargets.createdAt})`),
        )
        .limit(25),

      tx
        .select({
          skipReason: campaignTargets.skipReason,
          n: sql<number>`count(*)::int`,
        })
        .from(campaignTargets)
        .where(
          and(
            eq(campaignTargets.campaignId, id),
            eq(campaignTargets.status, 'skipped'),
          ),
        )
        .groupBy(campaignTargets.skipReason),

      tx
        .select({
          sendWindowStartHour: settings.sendWindowStartHour,
          sendWindowEndHour: settings.sendWindowEndHour,
          timezone: settings.timezone,
          skipWeekends: settings.skipWeekends,
          newContactCap24h: settings.newContactCap24h,
          warmupEnabled: settings.warmupEnabled,
        })
        .from(settings)
        .where(eq(settings.userId, userId))
        .limit(1),

      tx.execute<{ n: number }>(sql`
        select count(*)::int as n
          from new_contact_sends
         where session_id = ${row.sessionId}
           and sent_at > ${new Date(Date.now() - ROLLING_WINDOW_MS)}
      `),
    ]);

    return {
      ...row,
      recent,
      skipBreakdown,
      prefs: prefs[0] ?? null,
      used: Number(usedRows[0]?.n ?? 0),
    };
  });

  if (!data) notFound();

  const c = data.campaign;
  const done = c.sentCount + c.failedCount + c.skippedCount;
  const pct = c.totalTargets > 0 ? Math.round((done / c.totalTargets) * 100) : 0;
  const remaining = Math.max(0, c.totalTargets - done);

  const window = data.prefs
    ? {
        startHour: data.prefs.sendWindowStartHour,
        endHour: data.prefs.sendWindowEndHour,
        timezone: data.prefs.timezone,
        skipWeekends: data.prefs.skipWeekends,
      }
    : null;

  const daysSinceLink = data.linkedAt
    ? Math.floor((Date.now() - data.linkedAt.getTime()) / 86_400_000) + 1
    : 1;

  const cap =
    data.accountType && data.prefs
      ? effectiveCap({
          accountType: data.accountType,
          tier: Math.min(4, Math.max(1, data.tier ?? 1)) as 1 | 2 | 3 | 4,
          daysSinceLink,
          warmupEnabled: data.prefs.warmupEnabled,
          userCap: c.dailyCapOverride ?? data.prefs.newContactCap24h,
          platformCeiling: env().PLATFORM_MAX_NEW_CONTACTS_24H,
        })
      : null;

  const explanation = explainQuiet({
    status: c.status,
    sessionStatus: data.sessionStatus,
    throttledUntil: data.throttledUntil,
    window,
    used: data.used,
    cap,
    remaining,
  });

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/campaigns" className="hint underline underline-offset-2">
          ← Campaigns
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{c.name}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {[data.listName, data.templateName].filter(Boolean).join(' · ')}
          {data.sessionPhone ? ` · from ${formatForDisplay(data.sessionPhone)}` : ''}
        </p>
      </div>

      <section className="card">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">Progress</p>
          <p className="text-sm font-semibold tabular-nums">{pct}%</p>
        </div>
        <div
          role="progressbar"
          aria-valuenow={done}
          aria-valuemin={0}
          aria-valuemax={c.totalTargets}
          aria-label="Campaign progress"
          className="mt-2 h-2.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
        >
          <div
            className="h-full rounded-full bg-brand-500 transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <Figure label="Sent" value={c.sentCount} />
          <Figure label="Replies" value={c.replyCount} />
          <Figure label="Remaining" value={remaining} />
          <Figure label="Skipped" value={c.skippedCount} />
          {c.failedCount > 0 ? <Figure label="Failed" value={c.failedCount} /> : null}
          {cap !== null ? (
            <Figure label="Today's quota" text={`${data.used} / ${cap}`} />
          ) : null}
        </dl>
      </section>

      {explanation ? (
        <div
          className={`card ${
            explanation.tone === 'warn'
              ? 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
              : ''
          }`}
        >
          <p
            className={`text-sm ${
              explanation.tone === 'warn'
                ? 'text-amber-900 dark:text-amber-100'
                : 'text-neutral-700 dark:text-neutral-300'
            }`}
          >
            {explanation.text}
          </p>
        </div>
      ) : null}

      <CampaignControls
        campaignId={c.id}
        status={c.status}
        remaining={remaining}
      />

      {data.skipBreakdown.length > 0 ? (
        <section className="card">
          <h2 className="text-sm font-semibold">Why contacts were skipped</h2>
          <dl className="mt-3 space-y-2 text-sm">
            {data.skipBreakdown.map((s) => (
              <div
                key={s.skipReason ?? 'unknown'}
                className="flex items-baseline justify-between gap-3"
              >
                <dt className="text-neutral-600 dark:text-neutral-400">
                  {SKIP_LABEL[s.skipReason ?? ''] ?? 'Other'}
                </dt>
                <dd className="font-medium tabular-nums">{s.n}</dd>
              </div>
            ))}
          </dl>
          <p className="hint">
            Skipped contacts cost nothing against your daily limit.
          </p>
        </section>
      ) : null}

      <section aria-labelledby="recent-heading" className="space-y-3">
        <h2 id="recent-heading" className="text-sm font-semibold text-neutral-500">
          Recent activity
        </h2>

        {data.recent.length === 0 ? (
          <p className="card text-sm text-neutral-500">Nothing yet.</p>
        ) : (
          data.recent.map((t) => (
            <div key={t.targetId} className="card">
              <div className="flex items-start justify-between gap-3">
                <Link
                  href={`/dashboard/contacts/${t.contactId}`}
                  className="min-w-0 flex-1"
                >
                  <p className="truncate text-sm font-medium underline underline-offset-2">
                    {t.contactName ?? formatForDisplay(t.contactPhone)}
                  </p>
                  <p className="truncate font-mono text-xs text-neutral-500">
                    {formatForDisplay(t.contactPhone)}
                  </p>
                </Link>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <TargetTag status={t.status} skipReason={t.skipReason} />
                  {t.repliedAt ? (
                    <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-800 dark:bg-brand-900/40 dark:text-brand-200">
                      Replied
                    </span>
                  ) : null}
                </div>
              </div>

              {t.renderedBody ? (
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap rounded-xl bg-neutral-50 p-2.5 text-xs dark:bg-neutral-900">
                  {t.renderedBody}
                </p>
              ) : null}

              {t.lastError && t.status === 'failed' ? (
                <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                  {t.lastError}
                </p>
              ) : null}

              {t.sentAt ? (
                <p className="hint">{t.sentAt.toLocaleString()}</p>
              ) : null}
            </div>
          ))
        )}
      </section>
    </div>
  );
}

/**
 * Turns "running but nothing is happening" into a specific sentence.
 *
 * Ordered by precedence: a session problem beats a throttle hold, which beats
 * the sending window, which beats the daily quota.
 */
function explainQuiet(input: {
  status: string;
  sessionStatus: string | null;
  throttledUntil: Date | null;
  window: {
    startHour: number;
    endHour: number;
    timezone: string;
    skipWeekends: boolean;
  } | null;
  used: number;
  cap: number | null;
  remaining: number;
}): { text: string; tone: 'info' | 'warn' } | null {
  const { status, sessionStatus, throttledUntil, window, used, cap, remaining } = input;

  if (status === 'draft') {
    return {
      text: 'This campaign has not started. Nothing will be sent until you start it.',
      tone: 'info',
    };
  }
  if (status === 'completed') {
    return { text: 'Finished — every contact has been dealt with.', tone: 'info' };
  }
  if (status === 'cancelled') {
    return { text: 'Cancelled. The queue was cleared.', tone: 'info' };
  }
  if (status === 'paused') return null; // The pause reason is shown by the controls.
  if (status !== 'running') return null;

  if (sessionStatus === 'logged_out' || sessionStatus === 'banned') {
    return {
      text: 'The WhatsApp number is no longer linked, so sending has stopped. Re-link it to continue.',
      tone: 'warn',
    };
  }
  if (sessionStatus === 'disconnected' || sessionStatus === 'pending') {
    return {
      text: 'Reconnecting to WhatsApp. Sending resumes by itself once the connection is back.',
      tone: 'info',
    };
  }

  if (throttledUntil && throttledUntil.getTime() > Date.now()) {
    return {
      text: `WhatsApp asked this number to slow down. Sending is held until ${throttledUntil.toLocaleString()}. Reconnecting or re-linking now would make it worse, so the platform waits.`,
      tone: 'warn',
    };
  }

  if (window && !isWithinSendWindow(new Date(), window)) {
    const resumes = nextWindowOpensAt(new Date(), window);
    return {
      text: `Outside your sending hours (${window.startHour}:00–${window.endHour}:00 ${window.timezone}). Resumes ${resumes.toLocaleString()}.`,
      tone: 'info',
    };
  }

  if (cap !== null && used >= cap && remaining > 0) {
    return {
      text: `Today's limit of ${cap} new contacts is used up. Sending continues automatically as the rolling 24-hour window frees up.`,
      tone: 'info',
    };
  }

  return {
    text: 'Sending. Messages go out every 25–55 seconds, with longer pauses between batches, so this page will not change every second.',
    tone: 'info',
  };
}

function Figure({
  label,
  value,
  text,
}: {
  label: string;
  value?: number;
  text?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="mt-0.5 text-lg font-bold tabular-nums">
        {text ?? (value ?? 0).toLocaleString()}
      </dd>
    </div>
  );
}

const SKIP_LABEL: Record<string, string> = {
  duplicate: 'Already messaged',
  suppressed: 'Do not contact',
  invalid_number: 'Bad number',
  not_on_whatsapp: 'Not on WhatsApp',
  cooldown: 'Messaged too recently',
  cap_reached: 'Cancelled',
  outside_window: 'Outside sending hours',
};

function TargetTag({
  status,
  skipReason,
}: {
  status: string;
  skipReason: string | null;
}) {
  const label =
    status === 'skipped'
      ? (SKIP_LABEL[skipReason ?? ''] ?? 'Skipped')
      : status === 'sent'
        ? 'Sent'
        : status === 'failed'
          ? 'Failed'
          : status === 'sending'
            ? 'Sending'
            : 'Queued';

  const tone =
    status === 'sent'
      ? 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200'
      : status === 'failed'
        ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
        : 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300';

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}

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
  messageEvents,
  suppressions,
} from '@wa/db';
import { formatForDisplay } from '@wa/core';
import { queryAsUser } from '@/server/session';
import { SuppressionToggle } from './suppression-toggle';

export const metadata: Metadata = { title: 'Contact' };

/**
 * Everything known about one person: who they are from the spreadsheet, every
 * message sent to them with the exact text, and anything they replied.
 *
 * The exact rendered body is stored per send rather than reconstructed from
 * the template, because templates get edited and a transcript that silently
 * changes afterwards is worse than no transcript.
 */
export default async function ContactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const data = await queryAsUser(async (tx, userId) => {
    const rows = await tx
      .select({
        contact: contacts,
        listName: contactLists.name,
      })
      .from(contacts)
      .leftJoin(contactLists, eq(contactLists.id, contacts.listId))
      .where(and(eq(contacts.id, id), eq(contacts.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const [sends, replies, suppression] = await Promise.all([
      tx
        .select({
          targetId: campaignTargets.id,
          status: campaignTargets.status,
          skipReason: campaignTargets.skipReason,
          renderedBody: campaignTargets.renderedBody,
          sentAt: campaignTargets.sentAt,
          lastError: campaignTargets.lastError,
          campaignName: campaigns.name,
          campaignId: campaigns.id,
        })
        .from(campaignTargets)
        .innerJoin(campaigns, eq(campaigns.id, campaignTargets.campaignId))
        .where(
          and(
            eq(campaignTargets.userId, userId),
            eq(campaignTargets.contactId, id),
          ),
        )
        .orderBy(desc(campaignTargets.createdAt))
        .limit(50),

      tx
        .select({
          id: messageEvents.id,
          body: messageEvents.body,
          occurredAt: messageEvents.occurredAt,
        })
        .from(messageEvents)
        .where(
          and(
            eq(messageEvents.userId, userId),
            eq(messageEvents.contactId, id),
            eq(messageEvents.direction, 'in'),
          ),
        )
        .orderBy(desc(messageEvents.occurredAt))
        .limit(50),

      tx
        .select({ reason: suppressions.reason, note: suppressions.note })
        .from(suppressions)
        .where(
          and(
            eq(suppressions.userId, userId),
            eq(suppressions.phoneE164, row.contact.phoneE164),
          ),
        )
        .limit(1),
    ]);

    return { ...row, sends, replies, suppression: suppression[0] ?? null };
  });

  if (!data) notFound();

  const { contact } = data;
  const fields = Object.entries(contact.fields).filter(([, v]) => v.trim());

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/contacts" className="hint underline underline-offset-2">
          ← Contacts
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">
          {contact.name ?? formatForDisplay(contact.phoneE164)}
        </h1>
        <p className="mt-1 font-mono text-sm text-neutral-500">
          {formatForDisplay(contact.phoneE164)}
        </p>
      </div>

      {data.suppression ? (
        <div className="card border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950">
          <p className="font-semibold text-red-900 dark:text-red-100">
            {data.suppression.reason === 'opt_out'
              ? 'They asked to stop'
              : 'On your do-not-contact list'}
          </p>
          <p className="mt-1 text-sm text-red-800 dark:text-red-200">
            {data.suppression.note ??
              'No campaign will include this number, whatever your dedupe setting is.'}
          </p>
        </div>
      ) : null}

      <section className="grid grid-cols-3 gap-3">
        <Stat label="Sent" value={data.sends.filter((s) => s.status === 'sent').length} />
        <Stat label="Replies" value={data.replies.length} />
        <Stat
          label="On WhatsApp"
          text={
            contact.onWhatsapp === 'yes'
              ? 'Yes'
              : contact.onWhatsapp === 'no'
                ? 'No'
                : 'Unchecked'
          }
        />
      </section>

      {fields.length > 0 ? (
        <section className="card">
          <h2 className="text-sm font-semibold">From your spreadsheet</h2>
          <dl className="mt-3 space-y-2 text-sm">
            {fields.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[8rem_1fr] gap-3">
                <dt className="truncate text-neutral-500">{k}</dt>
                <dd className="break-words">{v}</dd>
              </div>
            ))}
          </dl>
          {data.listName ? (
            <p className="hint">Imported in {data.listName}.</p>
          ) : null}
        </section>
      ) : null}

      {data.replies.length > 0 ? (
        <section aria-labelledby="replies-heading" className="space-y-3">
          <h2 id="replies-heading" className="text-sm font-semibold text-neutral-500">
            Replies
          </h2>
          {data.replies.map((r) => (
            <div
              key={r.id}
              className="card border-brand-200 bg-brand-50 dark:border-brand-900 dark:bg-brand-950"
            >
              <p className="whitespace-pre-wrap text-sm text-brand-900 dark:text-brand-100">
                {r.body}
              </p>
              <p className="hint">{r.occurredAt.toLocaleString()}</p>
            </div>
          ))}
        </section>
      ) : null}

      <section aria-labelledby="history-heading" className="space-y-3">
        <h2 id="history-heading" className="text-sm font-semibold text-neutral-500">
          Message history
        </h2>

        {data.sends.length === 0 ? (
          <p className="card text-sm text-neutral-500">
            This contact has never been included in a campaign.
          </p>
        ) : (
          data.sends.map((s) => (
            <div key={s.targetId} className="card">
              <div className="flex items-start justify-between gap-3">
                <Link
                  href={`/dashboard/campaigns/${s.campaignId}`}
                  className="min-w-0 truncate text-sm font-medium underline underline-offset-2"
                >
                  {s.campaignName}
                </Link>
                <StatusTag status={s.status} skipReason={s.skipReason} />
              </div>

              {s.renderedBody ? (
                <p className="mt-3 whitespace-pre-wrap rounded-xl bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
                  {s.renderedBody}
                </p>
              ) : null}

              {s.lastError && s.status === 'failed' ? (
                <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                  {s.lastError}
                </p>
              ) : null}

              {s.sentAt ? <p className="hint">{s.sentAt.toLocaleString()}</p> : null}
            </div>
          ))
        )}
      </section>

      <SuppressionToggle
        contactId={contact.id}
        suppressed={Boolean(data.suppression)}
        isOptOut={data.suppression?.reason === 'opt_out'}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  text,
}: {
  label: string;
  value?: number;
  text?: string;
}) {
  return (
    <div className="card">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">
        {text ?? (value ?? 0).toLocaleString()}
      </p>
    </div>
  );
}

const SKIP_LABEL: Record<string, string> = {
  duplicate: 'Skipped — already messaged',
  suppressed: 'Skipped — do not contact',
  invalid_number: 'Skipped — bad number',
  not_on_whatsapp: 'Skipped — no WhatsApp',
  cooldown: 'Skipped — too soon',
  cap_reached: 'Skipped — daily cap',
  outside_window: 'Skipped — outside hours',
};

function StatusTag({
  status,
  skipReason,
}: {
  status: string;
  skipReason: string | null;
}) {
  const label =
    status === 'skipped' && skipReason
      ? (SKIP_LABEL[skipReason] ?? 'Skipped')
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
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}

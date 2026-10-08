import type { Metadata } from 'next';
import Link from 'next/link';
import {
  and,
  contactLists,
  contacts,
  count,
  desc,
  eq,
  isNull,
  sql,
  suppressions,
} from '@wa/db';
import { formatForDisplay } from '@wa/core';
import { queryAsUser } from '@/server/session';
import { ContactSearch } from './contact-search';

export const metadata: Metadata = { title: 'Contacts' };

/**
 * The contacts screen is the answer to "did I already message this person,
 * and who were they?".
 *
 * Search runs on the server against an indexed phone column plus the stored
 * spreadsheet fields, so a user can paste a number straight from WhatsApp or
 * type part of a business name and get the same answer either way.
 */

const PAGE_SIZE = 25;

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; filter?: string }>;
}) {
  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const filter = params.filter === 'messaged' || params.filter === 'new'
    ? params.filter
    : 'all';
  const page = Math.max(1, Number(params.page ?? '1') || 1);

  const data = await queryAsUser(async (tx, userId) => {
    // Phone search is normalised to digits so "+91 98765 43210",
    // "9876543210" and "919876543210" all find the same person.
    const digits = query.replace(/\D/g, '');
    const term = `%${query.toLowerCase()}%`;

    const conditions = [eq(contacts.userId, userId)];

    if (query) {
      conditions.push(
        sql`(
          ${contacts.name} ilike ${term}
          or (${digits} <> '' and regexp_replace(${contacts.phoneE164}, '\\D', '', 'g') like ${'%' + digits + '%'})
          or exists (
            select 1 from jsonb_each_text(${contacts.fields}) as f(k, v)
             where lower(f.v) like ${term}
          )
        )`,
      );
    }

    if (filter === 'messaged') {
      conditions.push(sql`${contacts.lastMessagedAt} is not null`);
    } else if (filter === 'new') {
      conditions.push(isNull(contacts.lastMessagedAt));
    }

    const where = and(...conditions);

    const [rows, total, stats, lists] = await Promise.all([
      tx
        .select({
          id: contacts.id,
          phoneE164: contacts.phoneE164,
          name: contacts.name,
          fields: contacts.fields,
          lastMessagedAt: contacts.lastMessagedAt,
          lastRepliedAt: contacts.lastRepliedAt,
          messageCount: contacts.messageCount,
          onWhatsapp: contacts.onWhatsapp,
          listName: contactLists.name,
          suppressed: sql<boolean>`exists (
            select 1 from ${suppressions} s
             where s.user_id = ${userId} and s.phone_e164 = ${contacts.phoneE164}
          )`,
        })
        .from(contacts)
        .leftJoin(contactLists, eq(contactLists.id, contacts.listId))
        .where(where)
        // Most recently touched first: the common question is about someone
        // you just messaged.
        .orderBy(desc(sql`coalesce(${contacts.lastMessagedAt}, ${contacts.createdAt})`))
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE),

      tx.select({ n: count() }).from(contacts).where(where),

      tx
        .select({
          all: count(),
          messaged: sql<number>`count(*) filter (where ${contacts.lastMessagedAt} is not null)::int`,
          replied: sql<number>`count(*) filter (where ${contacts.lastRepliedAt} is not null)::int`,
        })
        .from(contacts)
        .where(eq(contacts.userId, userId)),

      tx
        .select({
          id: contactLists.id,
          name: contactLists.name,
          rowsImported: contactLists.rowsImported,
          createdAt: contactLists.createdAt,
        })
        .from(contactLists)
        .where(and(eq(contactLists.userId, userId), isNull(contactLists.deletedAt)))
        .orderBy(desc(contactLists.createdAt))
        .limit(10),
    ]);

    return {
      rows: rows.map((r) => ({
        ...r,
        phoneDisplay: formatForDisplay(r.phoneE164),
        lastMessagedAt: r.lastMessagedAt?.toISOString() ?? null,
        lastRepliedAt: r.lastRepliedAt?.toISOString() ?? null,
      })),
      total: total[0]?.n ?? 0,
      stats: stats[0] ?? { all: 0, messaged: 0, replied: 0 },
      lists: lists.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })),
    };
  });

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Contacts</h1>
        <Link href="/dashboard/contacts/import" className="btn-primary shrink-0">
          Import
        </Link>
      </div>

      {data.stats.all === 0 ? (
        <section className="card">
          <h2 className="font-semibold">No contacts yet</h2>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Upload a spreadsheet with a column of phone numbers. Every other
            column becomes something you can use in your message, so a sheet
            with ratings or categories gives you more to personalise with.
          </p>
          <Link href="/dashboard/contacts/import" className="btn-primary mt-4 w-full">
            Import a spreadsheet
          </Link>
        </section>
      ) : (
        <>
          <section className="grid grid-cols-3 gap-3">
            <Stat label="Total" value={data.stats.all} />
            <Stat label="Messaged" value={data.stats.messaged} />
            <Stat label="Replied" value={data.stats.replied} />
          </section>

          <ContactSearch query={query} filter={filter} total={data.total} />

          {data.rows.length === 0 ? (
            <p className="card text-sm text-neutral-500">
              {query
                ? `Nothing matches “${query}”.`
                : 'No contacts match that filter.'}
            </p>
          ) : (
            <ul className="space-y-3">
              {data.rows.map((c) => (
                <li key={c.id}>
                  <Link href={`/dashboard/contacts/${c.id}`} className="card block">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {c.name ?? c.phoneDisplay}
                        </p>
                        <p className="truncate font-mono text-xs text-neutral-500">
                          {c.phoneDisplay}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {c.suppressed ? (
                          <Tag tone="red">Do not contact</Tag>
                        ) : c.lastRepliedAt ? (
                          <Tag tone="green">Replied</Tag>
                        ) : c.lastMessagedAt ? (
                          <Tag tone="neutral">Messaged</Tag>
                        ) : (
                          <Tag tone="blue">Not yet</Tag>
                        )}
                        {c.onWhatsapp === 'no' ? (
                          <Tag tone="amber">No WhatsApp</Tag>
                        ) : null}
                      </div>
                    </div>

                    <FieldSummary fields={c.fields} />

                    <p className="hint">
                      {c.lastMessagedAt
                        ? `Last messaged ${formatWhen(c.lastMessagedAt)}${c.messageCount > 1 ? ` · ${c.messageCount} messages` : ''}`
                        : 'Never messaged'}
                      {c.listName ? ` · ${c.listName}` : ''}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {pages > 1 ? (
            <nav className="flex items-center justify-between gap-3" aria-label="Pages">
              <PageLink
                page={page - 1}
                query={query}
                filter={filter}
                disabled={page <= 1}
              >
                Previous
              </PageLink>
              <span className="hint tabular-nums">
                Page {page} of {pages}
              </span>
              <PageLink
                page={page + 1}
                query={query}
                filter={filter}
                disabled={page >= pages}
              >
                Next
              </PageLink>
            </nav>
          ) : null}

          {data.lists.length > 0 ? (
            <section aria-labelledby="lists-heading" className="space-y-3">
              <h2 id="lists-heading" className="text-sm font-semibold text-neutral-500">
                Imported lists
              </h2>
              {data.lists.map((l) => (
                <div key={l.id} className="card flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{l.name}</p>
                    <p className="hint">
                      {l.rowsImported.toLocaleString()} contacts ·{' '}
                      {formatWhen(l.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The two or three stored columns most worth seeing in a list.
 *
 * Which columns exist is entirely up to whatever the user uploaded, so this
 * shows the first few non-empty ones rather than naming fields that may not be
 * there.
 */
function FieldSummary({ fields }: { fields: Record<string, string> }) {
  const entries = Object.entries(fields)
    .filter(([, v]) => v.trim())
    .slice(0, 3);
  if (entries.length === 0) return null;

  return (
    <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
      {entries.map(([k, v]) => (
        <span key={k} className="truncate">
          <span className="text-neutral-400">{k}:</span> {v}
        </span>
      ))}
    </p>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value.toLocaleString()}</p>
    </div>
  );
}

const TONE: Record<string, string> = {
  green: 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200',
  neutral: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

function Tag({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}>
      {children}
    </span>
  );
}

function PageLink({
  page,
  query,
  filter,
  disabled,
  children,
}: {
  page: number;
  query: string;
  filter: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="btn-secondary pointer-events-none opacity-40">{children}</span>
    );
  }
  const search = new URLSearchParams();
  if (query) search.set('q', query);
  if (filter !== 'all') search.set('filter', filter);
  if (page > 1) search.set('page', String(page));

  return (
    <Link href={`/dashboard/contacts?${search}`} className="btn-secondary">
      {children}
    </Link>
  );
}

function formatWhen(iso: string): string {
  const then = new Date(iso);
  const hours = (Date.now() - then.getTime()) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  if (hours < 24 * 7) return `${Math.round(hours / 24)}d ago`;
  return then.toLocaleDateString();
}

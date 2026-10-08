import type { Metadata } from 'next';
import Link from 'next/link';
import {
  and,
  contactLists,
  count,
  desc,
  eq,
  isNull,
  sql,
  templates,
  templateVariants,
} from '@wa/db';
import { queryAsUser } from '@/server/session';
import { createTemplateAndGo } from './actions';

export const metadata: Metadata = { title: 'Messages' };

export default async function TemplatesPage() {
  const data = await queryAsUser(async (tx, userId) => {
    const rows = await tx
      .select({
        id: templates.id,
        name: templates.name,
        updatedAt: templates.updatedAt,
        variantCount: sql<number>`count(${templateVariants.id}) filter (where ${templateVariants.weight} > 0)::int`,
        sentCount: sql<number>`coalesce(sum(${templateVariants.sentCount}), 0)::int`,
        replyCount: sql<number>`coalesce(sum(${templateVariants.replyCount}), 0)::int`,
        firstBody: sql<string | null>`min(${templateVariants.body})`,
      })
      .from(templates)
      .leftJoin(templateVariants, eq(templateVariants.templateId, templates.id))
      .where(and(eq(templates.userId, userId), isNull(templates.deletedAt)))
      .groupBy(templates.id)
      .orderBy(desc(templates.updatedAt));

    const lists = await tx
      .select({ n: count() })
      .from(contactLists)
      .where(and(eq(contactLists.userId, userId), isNull(contactLists.deletedAt)));

    return { templates: rows, hasLists: (lists[0]?.n ?? 0) > 0 };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Messages</h1>
        <form action={createTemplateAndGo}>
          <button type="submit" className="btn-primary shrink-0">
            New message
          </button>
        </form>
      </div>

      {data.templates.length === 0 ? (
        <section className="card">
          <h2 className="font-semibold">Write your first message</h2>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Use <code className="font-mono text-xs">{'{{name}}'}</code> and any
            column from your spreadsheet to make each message specific to the
            person receiving it. You can add a second version so not everyone
            gets identical wording.
          </p>
          {!data.hasLists ? (
            <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
              Importing contacts first means the preview can use a real one.{' '}
              <Link
                href="/dashboard/contacts/import"
                className="text-brand-600 underline"
              >
                Import a spreadsheet
              </Link>
              .
            </p>
          ) : null}
          <form action={createTemplateAndGo} className="mt-4">
            <button type="submit" className="btn-primary w-full">
              Write a message
            </button>
          </form>
        </section>
      ) : (
        <ul className="space-y-3">
          {data.templates.map((t) => (
            <li key={t.id}>
              <Link href={`/dashboard/templates/${t.id}`} className="card block">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 truncate font-medium">{t.name}</p>
                  {t.variantCount > 1 ? (
                    <span className="shrink-0 rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium dark:bg-neutral-800">
                      {t.variantCount} versions
                    </span>
                  ) : null}
                </div>

                {t.firstBody ? (
                  <p className="mt-2 line-clamp-2 text-sm text-neutral-600 dark:text-neutral-400">
                    {t.firstBody}
                  </p>
                ) : (
                  <p className="mt-2 text-sm italic text-neutral-500">Empty</p>
                )}

                <p className="hint tabular-nums">
                  {t.sentCount > 0
                    ? `${t.sentCount} sent · ${t.replyCount} ${t.replyCount === 1 ? 'reply' : 'replies'}${
                        t.sentCount >= 20
                          ? ` · ${Math.round((t.replyCount / t.sentCount) * 100)}% reply rate`
                          : ''
                      }`
                    : 'Not used yet'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, contactLists, contacts, count, eq, isNull } from '@wa/db';
import { queryAsUser } from '@/server/session';
import { loadTemplate } from '../actions';
import { TemplateEditor, type EditorVariant } from '../template-editor';

export const metadata: Metadata = { title: 'Edit message' };

export default async function TemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const loaded = await loadTemplate(id);
  if (!loaded) notFound();

  const context = await queryAsUser(async (tx, userId) => {
    const [lists, contactCount] = await Promise.all([
      tx
        .select({ columns: contactLists.columns })
        .from(contactLists)
        .where(and(eq(contactLists.userId, userId), isNull(contactLists.deletedAt))),
      tx.select({ n: count() }).from(contacts).where(eq(contacts.userId, userId)),
    ]);

    // Union of every column across the user's lists, so a template can be
    // written before deciding which list it will be sent to.
    const columns = new Set<string>();
    for (const list of lists) for (const c of list.columns) columns.add(c);

    return {
      columns: [...columns],
      hasContacts: (contactCount[0]?.n ?? 0) > 0,
    };
  });

  const variants: EditorVariant[] = loaded.variants
    // Retired variants are kept for their statistics but should not reappear
    // in the editor as if they were still in rotation.
    .filter((v) => v.weight > 0 || loaded.variants.every((x) => x.weight === 0))
    .map((v) => ({
      id: v.id,
      label: v.label,
      body: v.body,
      sentCount: v.sentCount,
      replyCount: v.replyCount,
    }));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/templates" className="hint underline underline-offset-2">
          ← Messages
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Edit message</h1>
      </div>

      <TemplateEditor
        templateId={loaded.template.id}
        initialName={loaded.template.name}
        initialVariants={variants}
        availableColumns={context.columns}
        hasContacts={context.hasContacts}
      />
    </div>
  );
}

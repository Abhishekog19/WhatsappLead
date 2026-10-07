'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  MAX_UPLOAD_BYTES,
  guessMapping,
  mapRows,
  type ImportResult,
  type RejectedRow,
} from '@wa/core';
import {
  and,
  auditLog,
  contactLists,
  contacts,
  eq,
  settings,
  sql,
} from '@wa/db';
import { queryAsUser } from '@/server/session';
import { decodeSpreadsheet, ImportFileError } from '@/server/spreadsheet';

/**
 * Spreadsheet import, in two steps.
 *
 * Step one decodes the file and returns a preview with a guessed column
 * mapping. Step two re-decodes it with the mapping the user confirmed and
 * writes the contacts.
 *
 * Re-decoding rather than stashing the parsed rows between steps is
 * deliberate. Holding thousands of rows in a server-side session for an
 * arbitrary length of time is memory the free-tier box does not have, and the
 * file is already on the user's device. The cost is parsing twice; the benefit
 * is that nothing is retained between requests.
 */

export interface PreviewResult {
  ok: boolean;
  message: string;
  preview?: {
    headers: string[];
    sheetName: string;
    totalRows: number;
    truncated: boolean;
    guess: { phone: string; name: string | null; suggestedIgnore: string[] };
    /** First few mapped rows, so the user can see it worked. */
    sample: { phoneE164: string; name: string | null; fields: Record<string, string> }[];
    rejectedCount: number;
    rejectedSample: RejectedRow[];
    /** Echoed back so step two does not have to re-ask. */
    suggestedListName: string;
  };
}

export async function previewImport(
  _prev: PreviewResult | null,
  formData: FormData,
): Promise<PreviewResult> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose a file to upload.' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    };
  }

  let decoded;
  try {
    decoded = await decodeSpreadsheet(file);
  } catch (err) {
    if (err instanceof ImportFileError) return { ok: false, message: err.message };
    throw err;
  }

  if (decoded.rows.length === 0) {
    return { ok: false, message: 'The file has headings but no rows.' };
  }

  const defaultCountry = await queryAsUser(async (tx, userId) => {
    const rows = await tx
      .select({ c: settings.defaultCountry })
      .from(settings)
      .where(eq(settings.userId, userId))
      .limit(1);
    return rows[0]?.c ?? 'IN';
  });

  const guess = guessMapping(decoded.headers);
  const mapped = mapRows(
    decoded.rows,
    { phone: guess.phone, name: guess.name, ignore: guess.suggestedIgnore },
    { defaultCountry },
  );

  return {
    ok: true,
    message: `${mapped.rows.length} of ${mapped.totalRows} rows are ready to import.`,
    preview: {
      headers: decoded.headers,
      sheetName: decoded.sheetName,
      totalRows: mapped.totalRows,
      truncated: decoded.truncated,
      guess: {
        phone: guess.phone,
        name: guess.name ?? null,
        suggestedIgnore: guess.suggestedIgnore,
      },
      sample: mapped.rows.slice(0, 3).map((r) => ({
        phoneE164: r.phoneE164,
        name: r.name,
        fields: r.fields,
      })),
      rejectedCount: mapped.rejected.length,
      rejectedSample: mapped.rejected.slice(0, 8),
      suggestedListName: suggestListName(file.name),
    },
  };
}

// ---------------------------------------------------------------------------

export interface CommitResult {
  ok: boolean;
  message: string;
  listId?: string;
  stats?: {
    imported: number;
    updated: number;
    invalid: number;
    duplicateInFile: number;
  };
}

const commitSchema = z.object({
  listName: z.string().trim().min(1, 'Name this list.').max(80),
  phoneColumn: z.string().min(1),
  nameColumn: z.string().nullable(),
  ignore: z.array(z.string()),
});

export async function commitImport(
  _prev: CommitResult | null,
  formData: FormData,
): Promise<CommitResult> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'The file is no longer attached. Choose it again.' };
  }

  const parsed = commitSchema.safeParse({
    listName: formData.get('listName'),
    phoneColumn: formData.get('phoneColumn'),
    nameColumn: formData.get('nameColumn') || null,
    ignore: formData.getAll('ignore').map(String),
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  let decoded;
  try {
    decoded = await decodeSpreadsheet(file);
  } catch (err) {
    if (err instanceof ImportFileError) return { ok: false, message: err.message };
    throw err;
  }

  const { listName, phoneColumn, nameColumn, ignore } = parsed.data;

  return queryAsUser(async (tx, userId) => {
    const prefs = await tx
      .select({ c: settings.defaultCountry })
      .from(settings)
      .where(eq(settings.userId, userId))
      .limit(1);

    const mapped: ImportResult = mapRows(
      decoded.rows,
      { phone: phoneColumn, name: nameColumn, ignore },
      { defaultCountry: prefs[0]?.c ?? 'IN' },
    );

    if (mapped.rows.length === 0) {
      return {
        ok: false,
        message:
          'No usable rows. Check that the phone column is right and the numbers include a country code.',
      };
    }

    const [list] = await tx
      .insert(contactLists)
      .values({
        userId,
        name: listName,
        sourceFilename: file.name.slice(0, 200),
        columns: mapped.columns,
        rowsTotal: mapped.totalRows,
        rowsInvalid: mapped.rejected.filter((r) => r.reason !== 'duplicate_in_file').length,
        rowsDuplicate: mapped.rejected.filter((r) => r.reason === 'duplicate_in_file').length,
      })
      .returning({ id: contactLists.id });

    if (!list) return { ok: false, message: 'Could not create the list.' };

    // Insert in chunks: one statement with 20,000 rows exceeds Postgres'
    // parameter limit, and a smaller batch also keeps the transaction's
    // memory footprint predictable on a small box.
    const CHUNK = 500;
    let inserted = 0;
    let updated = 0;

    for (let i = 0; i < mapped.rows.length; i += CHUNK) {
      const chunk = mapped.rows.slice(i, i + CHUNK);
      const result = await tx
        .insert(contacts)
        .values(
          chunk.map((r) => ({
            userId,
            listId: list.id,
            phoneE164: r.phoneE164,
            name: r.name,
            fields: r.fields,
          })),
        )
        // A number already on the account keeps its send history — that is
        // what makes per-account dedupe reliable across re-uploads — but takes
        // the newer name, details and list membership.
        .onConflictDoUpdate({
          target: [contacts.userId, contacts.phoneE164],
          set: {
            name: sql`coalesce(excluded.name, ${contacts.name})`,
            fields: sql`excluded.fields`,
            listId: sql`excluded.list_id`,
            updatedAt: new Date(),
          },
        })
        .returning({
          id: contacts.id,
          // Postgres cannot report which branch fired, so compare timestamps:
          // an insert leaves created_at and updated_at equal.
          isNew: sql<boolean>`${contacts.createdAt} = ${contacts.updatedAt}`,
        });

      for (const row of result) {
        if (row.isNew) inserted += 1;
        else updated += 1;
      }
    }

    await tx
      .update(contactLists)
      .set({ rowsImported: inserted + updated })
      .where(eq(contactLists.id, list.id));

    await tx.insert(auditLog).values({
      userId,
      action: 'contacts.import',
      entityType: 'contact_list',
      entityId: list.id,
      metadata: {
        filename: file.name,
        total: mapped.totalRows,
        inserted,
        updated,
        rejected: mapped.rejected.length,
      },
    });

    revalidatePath('/dashboard/contacts');
    return {
      ok: true,
      message: `Imported ${inserted + updated} contacts.`,
      listId: list.id,
      stats: {
        imported: inserted,
        updated,
        invalid: mapped.rejected.filter((r) => r.reason !== 'duplicate_in_file').length,
        duplicateInFile: mapped.rejected.filter((r) => r.reason === 'duplicate_in_file')
          .length,
      },
    };
  });
}

// ---------------------------------------------------------------------------

export async function deleteList(listId: string): Promise<{ ok: boolean; message: string }> {
  return queryAsUser(async (tx, userId) => {
    const inUse = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sql`campaigns`)
      .where(
        sql`user_id = ${userId} and list_id = ${listId} and status in ('running','scheduled','paused')`,
      );

    if (Number(inUse[0]?.n ?? 0) > 0) {
      return { ok: false, message: 'A campaign is still using this list.' };
    }

    // Soft delete. The contacts stay — their send history is what stops the
    // same person being messaged twice, and deleting a list should not
    // quietly make everyone in it eligible again.
    const result = await tx
      .update(contactLists)
      .set({ deletedAt: new Date() })
      .where(and(eq(contactLists.id, listId), eq(contactLists.userId, userId)))
      .returning({ id: contactLists.id });

    if (!result[0]) return { ok: false, message: 'List not found.' };

    revalidatePath('/dashboard/contacts');
    return { ok: true, message: 'List removed. Your contacts and history are kept.' };
  });
}

/** "leads-dermat_dental_vadodara.xlsx" -> "Leads dermat dental vadodara" */
function suggestListName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  if (!base) return 'Imported list';
  return base.charAt(0).toUpperCase() + base.slice(1, 80);
}

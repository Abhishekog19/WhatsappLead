'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  commitImport,
  previewImport,
  type CommitResult,
  type PreviewResult,
} from './actions';

/**
 * Upload, then confirm the column mapping, then import.
 *
 * The mapping step exists because the phone column cannot be guessed with
 * certainty, and getting it wrong means sending every message to the wrong
 * people. So the guess is shown as a suggestion the user confirms rather than
 * applied silently.
 *
 * The chosen File stays in React state across both steps. The server re-reads
 * it for the commit instead of holding thousands of parsed rows in memory
 * between two requests.
 */
export function ImportWizard() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Mapping, seeded from the server's guess once the preview arrives.
  const [phoneColumn, setPhoneColumn] = useState('');
  const [nameColumn, setNameColumn] = useState('');
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [listName, setListName] = useState('');

  function choose(selected: File | null): void {
    setFile(selected);
    setPreview(null);
    setResult(null);
    if (!selected) return;

    startTransition(async () => {
      const fd = new FormData();
      fd.set('file', selected);
      const r = await previewImport(null, fd);
      setPreview(r);
      if (r.ok && r.preview) {
        setPhoneColumn(r.preview.guess.phone);
        setNameColumn(r.preview.guess.name ?? '');
        setIgnored(new Set(r.preview.guess.suggestedIgnore));
        setListName(r.preview.suggestedListName);
      }
    });
  }

  function reMap(next: {
    phone?: string;
    name?: string;
    ignore?: Set<string>;
  }): void {
    // Re-running the preview on every checkbox would upload the file again for
    // each click. The mapping controls update local state; the authoritative
    // pass happens on import.
    if (next.phone !== undefined) setPhoneColumn(next.phone);
    if (next.name !== undefined) setNameColumn(next.name);
    if (next.ignore !== undefined) setIgnored(next.ignore);
  }

  function submit(): void {
    if (!file) return;
    startTransition(async () => {
      const fd = new FormData();
      fd.set('file', file);
      fd.set('listName', listName);
      fd.set('phoneColumn', phoneColumn);
      if (nameColumn) fd.set('nameColumn', nameColumn);
      for (const column of ignored) fd.append('ignore', column);

      const r = await commitImport(null, fd);
      setResult(r);
      if (r.ok) router.refresh();
    });
  }

  const placeholders = useMemo(() => {
    if (!preview?.preview) return [];
    return preview.preview.headers
      .filter((h) => !ignored.has(h) && h !== phoneColumn)
      .map((h) => `{{${h}}}`);
  }, [preview, ignored, phoneColumn]);

  if (result?.ok) {
    return (
      <div className="card border-brand-300 bg-brand-50 dark:border-brand-800 dark:bg-brand-950">
        <p className="font-semibold text-brand-900 dark:text-brand-100">
          {result.message}
        </p>
        {result.stats ? (
          <ul className="mt-2 space-y-1 text-sm text-brand-800 dark:text-brand-200">
            <li>{result.stats.imported} new contacts added</li>
            {result.stats.updated > 0 ? (
              <li>
                {result.stats.updated} already on your account were updated — their
                send history is kept
              </li>
            ) : null}
            {result.stats.invalid > 0 ? (
              <li>{result.stats.invalid} rows had no usable phone number</li>
            ) : null}
            {result.stats.duplicateInFile > 0 ? (
              <li>
                {result.stats.duplicateInFile} duplicate numbers inside the file were
                collapsed
              </li>
            ) : null}
          </ul>
        ) : null}
        <div className="mt-4 flex gap-2">
          <a href="/dashboard/campaigns/new" className="btn-primary flex-1">
            Start a campaign
          </a>
          <button
            type="button"
            onClick={() => {
              setFile(null);
              setPreview(null);
              setResult(null);
              if (inputRef.current) inputRef.current.value = '';
            }}
            className="btn-secondary flex-1"
          >
            Import another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="card space-y-3">
        <div>
          <h2 className="font-semibold">Upload your spreadsheet</h2>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            A .xlsx or .csv file. It needs a heading row, a column of phone
            numbers, and ideally a name column. Every other column becomes
            available in your message.
          </p>
        </div>

        <label className="label" htmlFor="import-file">
          Choose file
        </label>
        <input
          ref={inputRef}
          id="import-file"
          type="file"
          accept=".xlsx,.xlsm,.csv"
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
          className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-xl file:border-0 file:bg-brand-600 file:px-4 file:text-sm file:font-medium file:text-white"
        />

        {file ? (
          <p className="hint">
            {file.name} · {(file.size / 1024).toFixed(0)} KB
          </p>
        ) : null}

        {pending && !preview ? (
          <p className="hint" role="status">
            Reading the file…
          </p>
        ) : null}

        {preview && !preview.ok ? (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
          >
            {preview.message}
          </p>
        ) : null}
      </div>

      {preview?.ok && preview.preview ? (
        <>
          <section className="card space-y-4">
            <div>
              <h2 className="font-semibold">Check the columns</h2>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                Found {preview.preview.totalRows.toLocaleString()} rows in{' '}
                <span className="font-medium">{preview.preview.sheetName}</span>.
              </p>
              {preview.preview.truncated ? (
                <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
                  Only the first 20,000 rows were read.
                </p>
              ) : null}
            </div>

            <div>
              <label htmlFor="phone-col" className="label">
                Phone number column
              </label>
              <select
                id="phone-col"
                value={phoneColumn}
                onChange={(e) => reMap({ phone: e.target.value })}
                className="input"
              >
                {preview.preview.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
              <p className="hint">
                Numbers without a country code are assumed to be from your
                default country, set in Settings.
              </p>
            </div>

            <div>
              <label htmlFor="name-col" className="label">
                Name column
              </label>
              <select
                id="name-col"
                value={nameColumn}
                onChange={(e) => reMap({ name: e.target.value })}
                className="input"
              >
                <option value="">— none —</option>
                {preview.preview.headers
                  .filter((h) => h !== phoneColumn)
                  .map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
              </select>
              <p className="hint">Used for {'{{name}}'} in your message.</p>
            </div>

            <fieldset>
              <legend className="label">Columns to skip</legend>
              <p className="hint mb-2">
                Anything left ticked is not stored. Pre-ticked columns look like
                they were generated by another tool.
              </p>
              <div className="space-y-2">
                {preview.preview.headers
                  .filter((h) => h !== phoneColumn && h !== nameColumn)
                  .map((h) => (
                    <label key={h} className="flex min-h-11 items-center gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={ignored.has(h)}
                        onChange={(e) => {
                          const next = new Set(ignored);
                          if (e.target.checked) next.add(h);
                          else next.delete(h);
                          reMap({ ignore: next });
                        }}
                        className="size-5 rounded border-neutral-300 text-brand-600"
                      />
                      <span className="truncate">{h}</span>
                    </label>
                  ))}
              </div>
            </fieldset>
          </section>

          <section className="card space-y-3">
            <h2 className="font-semibold">How it looks</h2>
            {preview.preview.sample.map((row, i) => (
              <div key={i} className="rounded-xl bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
                <p className="font-medium">{row.name ?? '(no name)'}</p>
                <p className="font-mono text-xs text-neutral-500">{row.phoneE164}</p>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  {Object.entries(row.fields)
                    .filter(([k]) => !ignored.has(k))
                    .slice(0, 6)
                    .map(([k, v]) => (
                      <div key={k} className="col-span-2 grid grid-cols-subgrid">
                        <dt className="text-neutral-500">{k}</dt>
                        <dd className="truncate">{v}</dd>
                      </div>
                    ))}
                </dl>
              </div>
            ))}

            {placeholders.length > 0 ? (
              <div>
                <p className="label">Available in your message</p>
                <p className="mt-1 flex flex-wrap gap-1.5">
                  {['{{name}}', ...placeholders].map((p) => (
                    <code
                      key={p}
                      className="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-xs dark:bg-neutral-800"
                    >
                      {p}
                    </code>
                  ))}
                </p>
              </div>
            ) : null}
          </section>

          {preview.preview.rejectedCount > 0 ? (
            <section className="card">
              <h2 className="font-semibold">
                {preview.preview.rejectedCount} rows will be skipped
              </h2>
              <ul className="mt-2 space-y-1 text-sm text-neutral-600 dark:text-neutral-400">
                {preview.preview.rejectedSample.map((r) => (
                  <li key={r.sourceRow} className="flex gap-2">
                    <span className="shrink-0 tabular-nums text-neutral-400">
                      Row {r.sourceRow}
                    </span>
                    <span className="truncate">
                      {r.name ? `${r.name} — ` : ''}
                      {REJECT_LABEL[r.reason]}
                      {r.value && r.reason === 'invalid_phone' ? ` (“${r.value}”)` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              {preview.preview.rejectedCount > preview.preview.rejectedSample.length ? (
                <p className="hint">
                  …and {preview.preview.rejectedCount - preview.preview.rejectedSample.length}{' '}
                  more.
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="card space-y-4">
            <div>
              <label htmlFor="list-name" className="label">
                Name this list
              </label>
              <input
                id="list-name"
                value={listName}
                onChange={(e) => setListName(e.target.value)}
                maxLength={80}
                className="input"
              />
            </div>

            {result && !result.ok ? (
              <p
                role="alert"
                className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
              >
                {result.message}
              </p>
            ) : null}

            <button
              type="button"
              onClick={submit}
              disabled={pending || !listName.trim()}
              className="btn-primary w-full"
            >
              {pending ? 'Importing…' : 'Import contacts'}
            </button>
            <p className="hint">
              Numbers already on your account keep their message history, so
              re-uploading a sheet will not message anyone twice.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}

const REJECT_LABEL: Record<string, string> = {
  missing_phone: 'no phone number',
  invalid_phone: 'phone number could not be read',
  duplicate_in_file: 'appears twice in this file',
};

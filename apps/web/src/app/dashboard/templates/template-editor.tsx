'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  deleteTemplate,
  previewTemplate,
  saveTemplate,
  type PreviewRender,
  type TemplateResult,
} from './actions';

/**
 * The message editor.
 *
 * Two things here are not cosmetic. The live preview renders against a real
 * contact, because that is the only way the user finds out their 90-character
 * business name breaks the opening line. And the variant list exists because
 * sending thousands of byte-identical messages is the single clearest signal
 * a spam classifier looks for.
 */

export interface EditorVariant {
  id: string | null;
  label: string | null;
  body: string;
  sentCount: number;
  replyCount: number;
}

const MAX_VARIANTS = 5;

export function TemplateEditor({
  templateId,
  initialName,
  initialVariants,
  availableColumns,
  hasContacts,
}: {
  templateId: string;
  initialName: string;
  initialVariants: EditorVariant[];
  availableColumns: string[];
  hasContacts: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [variants, setVariants] = useState<EditorVariant[]>(
    initialVariants.length > 0
      ? initialVariants
      : [{ id: null, label: null, body: '', sentCount: 0, replyCount: 0 }],
  );
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<TemplateResult | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const nameId = useId();

  const current = variants[active] ?? variants[0]!;

  function update(index: number, patch: Partial<EditorVariant>): void {
    setVariants((prev) =>
      prev.map((v, i) => (i === index ? { ...v, ...patch } : v)),
    );
  }

  function addVariant(): void {
    if (variants.length >= MAX_VARIANTS) return;
    setVariants((prev) => [
      ...prev,
      {
        id: null,
        label: `Version ${String.fromCharCode(66 + prev.length - 1)}`,
        // Seeded from the current text: a variant is usually a reword, not a
        // blank page.
        body: current.body,
        sentCount: 0,
        replyCount: 0,
      },
    ]);
    setActive(variants.length);
  }

  function removeVariant(index: number): void {
    if (variants.length <= 1) return;
    setVariants((prev) => prev.filter((_, i) => i !== index));
    setActive((a) => (a >= index && a > 0 ? a - 1 : a));
  }

  function save(): void {
    startTransition(async () => {
      const fd = new FormData();
      fd.set('templateId', templateId);
      fd.set('name', name);
      fd.set(
        'variants',
        JSON.stringify(
          variants.map((v) => ({
            id: v.id,
            label: v.label?.trim() || null,
            body: v.body,
          })),
        ),
      );
      const r = await saveTemplate(null, fd);
      setResult(r);
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="card space-y-4">
        <div>
          <label htmlFor={nameId} className="label">
            Message name
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className="input"
          />
          <p className="hint">Just for you — recipients never see it.</p>
        </div>
      </div>

      {variants.length > 1 ? (
        <div
          role="tablist"
          aria-label="Message versions"
          className="flex gap-2 overflow-x-auto pb-1"
        >
          {variants.map((v, i) => (
            <button
              key={i}
              role="tab"
              type="button"
              aria-selected={active === i}
              onClick={() => setActive(i)}
              className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-medium transition-colors ${
                active === i
                  ? 'bg-brand-600 text-white'
                  : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300'
              }`}
            >
              {v.label?.trim() || `Version ${String.fromCharCode(65 + i)}`}
              {v.sentCount > 0 ? (
                <span className="ml-2 tabular-nums opacity-70">
                  {v.replyCount}/{v.sentCount}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <VariantEditor
        key={active}
        variant={current}
        index={active}
        total={variants.length}
        availableColumns={availableColumns}
        hasContacts={hasContacts}
        onChange={(patch) => update(active, patch)}
        onRemove={variants.length > 1 ? () => removeVariant(active) : null}
      />

      {variants.length < MAX_VARIANTS ? (
        <button type="button" onClick={addVariant} className="btn-secondary w-full">
          Add another version
        </button>
      ) : null}

      {result ? (
        <div
          role="status"
          className={`rounded-xl p-3 text-sm ${
            result.ok
              ? 'border border-brand-200 bg-brand-50 text-brand-800 dark:border-brand-900 dark:bg-brand-950 dark:text-brand-200'
              : 'border border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200'
          }`}
        >
          <p>{result.message}</p>
          {result.problems && result.problems.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {result.problems.map((p, i) => (
                <li key={i}>{p.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="btn-primary flex-1"
        >
          {pending ? 'Saving…' : 'Save message'}
        </button>
        <DeleteButton templateId={templateId} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function VariantEditor({
  variant,
  index,
  total,
  availableColumns,
  hasContacts,
  onChange,
  onRemove,
}: {
  variant: EditorVariant;
  index: number;
  total: number;
  availableColumns: string[];
  hasContacts: boolean;
  onChange: (patch: Partial<EditorVariant>) => void;
  onRemove: (() => void) | null;
}) {
  const bodyId = useId();
  const labelId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<PreviewRender | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // Debounced because each render is a round trip to fetch a real contact.
  useEffect(() => {
    if (!variant.body.trim() || !hasContacts) {
      setPreview(null);
      return;
    }
    setPreviewing(true);
    const timer = setTimeout(async () => {
      const r = await previewTemplate(variant.body);
      setPreview(r);
      setPreviewing(false);
    }, 500);
    return () => {
      clearTimeout(timer);
      setPreviewing(false);
    };
  }, [variant.body, hasContacts]);

  /** Inserts a placeholder at the cursor rather than appending it. */
  function insert(token: string): void {
    const el = textareaRef.current;
    if (!el) {
      onChange({ body: variant.body + token });
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = variant.body.slice(0, start) + token + variant.body.slice(end);
    onChange({ body: next });
    // Restore the caret after React has re-rendered with the new value.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  const tooLong = variant.body.length > 4096;

  return (
    <div className="card space-y-4">
      {total > 1 ? (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label htmlFor={labelId} className="label">
              Version name
            </label>
            <input
              id={labelId}
              value={variant.label ?? ''}
              onChange={(e) => onChange({ label: e.target.value })}
              maxLength={40}
              placeholder={`Version ${String.fromCharCode(65 + index)}`}
              className="input"
            />
          </div>
          {onRemove ? (
            <button type="button" onClick={onRemove} className="btn-secondary">
              Remove
            </button>
          ) : null}
        </div>
      ) : null}

      <div>
        <label htmlFor={bodyId} className="label">
          Message
        </label>
        <textarea
          ref={textareaRef}
          id={bodyId}
          value={variant.body}
          onChange={(e) => onChange({ body: e.target.value })}
          rows={8}
          className="input resize-y py-3 leading-relaxed"
          placeholder="Hi {{name}}, …"
        />
        <p className={`hint tabular-nums ${tooLong ? 'text-red-700 dark:text-red-300' : ''}`}>
          {variant.body.length} characters
          {tooLong ? ' — over WhatsApp’s 4096 limit' : ''}
        </p>
      </div>

      <div>
        <p className="label">Insert a detail</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {['name', ...availableColumns.filter((c) => c.toLowerCase() !== 'name')]
            .slice(0, 14)
            .map((column) => (
              <button
                key={column}
                type="button"
                onClick={() => insert(`{{${column}}}`)}
                className="min-h-9 rounded-lg bg-neutral-100 px-2.5 font-mono text-xs dark:bg-neutral-800"
              >
                {`{{${column}}}`}
              </button>
            ))}
        </div>
        <p className="hint">
          Tap to insert. A placeholder with no value for a contact is left out,
          and the spacing around it is tidied up.
        </p>
      </div>

      <div>
        <p className="label">Vary the wording</p>
        <button
          type="button"
          onClick={() => insert('{Hi|Hello|Hey}')}
          className="mt-1 min-h-9 rounded-lg bg-neutral-100 px-2.5 font-mono text-xs dark:bg-neutral-800"
        >
          {'{Hi|Hello|Hey}'}
        </button>
        <p className="hint">
          One option is picked at random per message. Identical messages to
          hundreds of people is the clearest spam signal there is, so varying a
          few words genuinely helps.
        </p>
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <p className="label">Preview</p>
          {previewing ? <span className="hint">updating…</span> : null}
        </div>

        {!hasContacts ? (
          <p className="hint">
            Import some contacts and the preview will use a real one.
          </p>
        ) : preview ? (
          <>
            <div className="mt-1 rounded-2xl rounded-br-md bg-brand-600 px-3 py-2 text-sm text-white">
              <p className="whitespace-pre-wrap break-words">{preview.text}</p>
            </div>
            <p className="hint">
              As {preview.contactName ?? 'your most recent contact'} would see it
              {preview.length !== variant.body.length
                ? ` · ${preview.length} characters sent`
                : ''}
            </p>
            {preview.missing.length > 0 ? (
              <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                No value for {preview.missing.map((m) => `{{${m}}}`).join(', ')} on
                this contact — it was left out.
              </p>
            ) : null}
          </>
        ) : (
          <p className="hint">Start typing to see a preview.</p>
        )}
      </div>
    </div>
  );
}

function DeleteButton({ templateId }: { templateId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="btn-secondary"
      >
        Delete
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await deleteTemplate(templateId);
            if (r.ok) router.push('/dashboard/templates');
            else setError(r.message);
            setConfirming(false);
          })
        }
        className="btn bg-red-600 text-white hover:bg-red-700"
      >
        {pending ? '…' : 'Confirm'}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </>
  );
}

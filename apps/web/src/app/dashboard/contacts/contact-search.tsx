'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useState } from 'react';

/**
 * Search box and filters for the contacts list.
 *
 * The query lives in the URL rather than in component state, so a search is
 * shareable, survives a refresh, and keeps the results rendering on the
 * server where the indexes are.
 *
 * Typing is debounced because each change is a round trip. 350ms is long
 * enough to skip intermediate keystrokes and short enough that the list feels
 * like it is reacting rather than loading.
 */
export function ContactSearch({
  query,
  filter,
  total,
}: {
  query: string;
  filter: string;
  total: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState(query);
  const inputId = useId();

  // Keep in step when navigation changes the URL from elsewhere — back
  // button, a filter chip, a link into a saved search.
  useEffect(() => setValue(query), [query]);

  useEffect(() => {
    if (value === query) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (value.trim()) next.set('q', value.trim());
      else next.delete('q');
      // Any change to the query invalidates the current page number.
      next.delete('page');
      router.replace(`/dashboard/contacts?${next}`, { scroll: false });
    }, 350);
    return () => clearTimeout(timer);
  }, [value, query, params, router]);

  function setFilter(next: string): void {
    const search = new URLSearchParams(params);
    if (next === 'all') search.delete('filter');
    else search.set('filter', next);
    search.delete('page');
    router.replace(`/dashboard/contacts?${search}`, { scroll: false });
  }

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={inputId} className="sr-only">
          Search contacts
        </label>
        <div className="relative">
          <input
            id={inputId}
            type="search"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Search a number, name or business detail"
            className="input pr-10"
            autoComplete="off"
            enterKeyHint="search"
          />
          {value ? (
            <button
              type="button"
              onClick={() => setValue('')}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-neutral-500"
            >
              ×
            </button>
          ) : null}
        </div>
        <p className="hint">
          Paste a number in any format, or type part of a name, category,
          address — anything from your spreadsheet.
        </p>
      </div>

      <div
        role="group"
        aria-label="Filter contacts"
        className="flex gap-2 overflow-x-auto pb-1"
      >
        {[
          { key: 'all', label: 'All' },
          { key: 'messaged', label: 'Messaged' },
          { key: 'new', label: 'Not messaged' },
        ].map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={filter === option.key}
            onClick={() => setFilter(option.key)}
            className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-medium transition-colors ${
              filter === option.key
                ? 'bg-brand-600 text-white'
                : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <p className="hint tabular-nums" role="status">
        {total.toLocaleString()} {total === 1 ? 'contact' : 'contacts'}
        {query ? ' matching' : ''}
      </p>
    </div>
  );
}

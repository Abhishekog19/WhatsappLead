import type { Metadata } from 'next';
import Link from 'next/link';
import { eq, settings as settingsTable } from '@wa/db';
import { queryAsUser } from '@/server/session';
import { SettingsForm, type SettingsValues } from './settings-form';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const row = await queryAsUser(async (tx, userId) => {
    const [found] = await tx
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.userId, userId))
      .limit(1);

    if (found) return found;

    // A settings row is created on sign-up; this covers accounts that predate
    // that hook, and makes the page impossible to land on empty.
    const [created] = await tx
      .insert(settingsTable)
      .values({ userId })
      .onConflictDoNothing()
      .returning();
    return created;
  });

  if (!row) {
    return (
      <p role="alert" className="card text-sm">
        Could not load your settings. Please reload the page.
      </p>
    );
  }

  const values: SettingsValues = {
    dedupeMode: row.dedupeMode,
    cooldownDays: row.cooldownDays,
    newContactCap24h: row.newContactCap24h,
    warmupEnabled: row.warmupEnabled,
    minDelayMs: row.minDelayMs,
    maxDelayMs: row.maxDelayMs,
    batchSize: row.batchSize,
    sendWindowStartHour: row.sendWindowStartHour,
    sendWindowEndHour: row.sendWindowEndHour,
    skipWeekends: row.skipWeekends,
    timezone: row.timezone,
    defaultCountry: row.defaultCountry,
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

      <Link href="/dashboard/settings/numbers" className="card flex items-center justify-between gap-3">
        <span>
          <span className="block font-medium">WhatsApp numbers</span>
          <span className="block text-sm text-neutral-500">
            Link a number, or unlink one you no longer use
          </span>
        </span>
        <span aria-hidden className="text-neutral-400">
          →
        </span>
      </Link>

      <SettingsForm values={values} />
    </div>
  );
}

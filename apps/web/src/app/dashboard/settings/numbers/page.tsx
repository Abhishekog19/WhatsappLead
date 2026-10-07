import type { Metadata } from 'next';
import Link from 'next/link';
import { and, eq, isNull, settings, waSessions } from '@wa/db';
import { queryAsUser } from '@/server/session';
import { NumbersManager, type ExistingSession } from './numbers-manager';

export const metadata: Metadata = { title: 'WhatsApp numbers' };

export default async function NumbersPage() {
  const data = await queryAsUser(async (tx, userId) => {
    const [rows, prefs] = await Promise.all([
      tx
        .select({
          id: waSessions.id,
          label: waSessions.label,
          phoneE164: waSessions.phoneE164,
          status: waSessions.status,
          accountType: waSessions.accountType,
          lastError: waSessions.lastError,
          linkedAt: waSessions.linkedAt,
        })
        .from(waSessions)
        .where(and(eq(waSessions.userId, userId), isNull(waSessions.deletedAt)))
        .orderBy(waSessions.createdAt),
      tx
        .select({ defaultCountry: settings.defaultCountry })
        .from(settings)
        .where(eq(settings.userId, userId))
        .limit(1),
    ]);

    return {
      sessions: rows.map(
        (r): ExistingSession => ({
          ...r,
          linkedAt: r.linkedAt?.toISOString() ?? null,
        }),
      ),
      defaultCountry: prefs[0]?.defaultCountry ?? 'IN',
    };
  });

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/settings" className="hint underline underline-offset-2">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">WhatsApp numbers</h1>
      </div>

      <NumbersManager
        sessions={data.sessions}
        defaultCountry={data.defaultCountry}
      />

      <section className="card">
        <h2 className="text-sm font-semibold">Worth knowing</h2>
        <ul className="mt-2 space-y-2 text-sm text-neutral-600 dark:text-neutral-400">
          <li>
            Linking here does not sign you out of WhatsApp anywhere. It adds a
            linked device, the same as WhatsApp Web.
          </li>
          <li>
            A newly linked number starts at a low daily limit and earns its way
            up over about a week. That ramp is the main thing protecting the
            number, so it is on by default.
          </li>
          <li>
            If WhatsApp tells us to slow down, sending stops on its own and the
            number is held. Reconnecting or re-linking in that situation makes
            it worse, so the platform will not do it.
          </li>
        </ul>
      </section>
    </div>
  );
}

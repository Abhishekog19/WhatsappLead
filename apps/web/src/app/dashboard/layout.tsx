import { signOut } from '@/server/auth';
import { requireUser } from '@/server/session';
import { BottomNav, SideNav } from '@/components/nav';

/**
 * The real authentication gate. The Edge middleware only sniffs for a cookie;
 * this validates the session against Postgres before anything renders.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  return (
    <div className="flex min-h-dvh">
      <SideNav />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex min-h-14 items-center justify-between gap-3 border-b border-neutral-200 bg-white/90 px-4 backdrop-blur-sm dark:border-neutral-800 dark:bg-neutral-950/90">
          <span className="truncate text-sm font-semibold">WhatsApp Outreach</span>

          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/' });
            }}
          >
            <button
              type="submit"
              className="flex min-h-11 items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400"
            >
              <span className="hidden max-w-40 truncate sm:inline">
                {user.email ?? user.name}
              </span>
              <span className="underline underline-offset-2">Sign out</span>
            </button>
          </form>
        </header>

        {/* pb-20 keeps content clear of the fixed bottom tab bar on phones. */}
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-5 pb-20 sm:pb-8">
          {children}
        </main>
      </div>

      <BottomNav />
    </div>
  );
}

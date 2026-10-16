import { DrizzleAdapter } from '@auth/drizzle-adapter';
import type { Adapter } from 'next-auth/adapters';
import { asSystem, eq, users, type Database, type Tx } from '@wa/db';

/** Only call with the email from the verified OAuth provider response. */
export async function canSignInByEmail(db: Database, email: string): Promise<boolean> {
  const rows = await asSystem(db, (tx) => tx.select({ suspendedAt: users.suspendedAt })
    .from(users).where(eq(users.email, email)).limit(1));
  return rows.length === 0 || rows[0]!.suspendedAt === null;
}

/**
 * The Auth.js adapter, with the trusted database access it actually needs.
 *
 * `users` has FORCE ROW LEVEL SECURITY, and its policies are
 * `id = app_current_user_id()` or `app_is_system()`. Sign-in runs before
 * either is true: there is no authenticated tenant yet — establishing one is
 * the whole point of the request. So an adapter handed a plain connection sees
 * no rows and writes none. Every query silently matches nothing.
 *
 * On a superuser connection that is invisible, because RLS is skipped
 * entirely. On the restricted role this deployment uses it is fatal:
 * `getUserByAccount` returns nothing so a returning user looks new,
 * `createUser` is refused by the policy's WITH CHECK, and
 * `getSessionAndUser` cannot join `users`, so a valid session reads as invalid
 * and the browser bounces between the app and the sign-in page.
 *
 * Authentication is therefore a legitimate bootstrap path, and gets the
 * documented escape hatch — but narrowly:
 *
 *   - Only these nineteen adapter methods, nothing else in the app.
 *   - Only for the duration of one call. `asSystem` sets `app.system`
 *     transaction-locally, so the escalation cannot outlive the statement or
 *     leak to whichever request borrows the pooled connection next.
 *   - No tenant policy is relaxed. The tables users query through
 *     `withUser()` are untouched; this does not widen them.
 *   - Nothing here trusts the browser. Auth.js supplies either a session
 *     token it issued itself or a provider account id Google has verified,
 *     and the user id comes back out of the database. A caller cannot name
 *     the identity they want.
 *
 * The alternative — a policy on `users` permissive enough for an
 * unauthenticated sign-in — would have to allow reads with no identity at
 * all, which is the same escalation with none of the confinement.
 */

/**
 * The table set DrizzleAdapter expects.
 *
 * Taken from the adapter's own generic instantiated at our Database type,
 * rather than from the bare `Parameters<typeof DrizzleAdapter>`: that resolves
 * to a union across the Postgres, MySQL and SQLite flavours, and a mistyped
 * table would then only fail somewhere deep inside the union.
 */
type AdapterTables = NonNullable<Parameters<typeof DrizzleAdapter<Database>>[1]>;

export function createTrustedAdapter(
  db: Database,
  tables: AdapterTables,
): Adapter {
  // Built once against the pool purely to enumerate the real method set.
  // Wrapping a Proxy instead would claim every method exists, and Auth.js
  // probes for optional ones — `getAccount`, the authenticator methods — to
  // decide which features to enable.
  const shape = DrizzleAdapter(db, tables) as Record<string, unknown>;
  const trusted: Record<string, unknown> = {};

  for (const method of Object.keys(shape)) {
    if (typeof shape[method] !== 'function') {
      trusted[method] = shape[method];
      continue;
    }

    trusted[method] = (...args: unknown[]) =>
      asSystem(db, async (tx) => {
        // Rebuilt per call against the transaction, so the query runs on the
        // connection that has app.system set. The adapter only ever calls
        // select/insert/update/delete, all of which a transaction provides.
        const inner = DrizzleAdapter(tx as unknown as Database, tables) as Record<
          string,
          (...a: unknown[]) => Promise<unknown>
        >;
        const result = await inner[method]!(...args);
        if (method === 'getSessionAndUser' && result &&
            (result as { user?: { suspendedAt?: Date | null } }).user?.suspendedAt) return null;
        return result;
      });
  }

  return trusted as Adapter;
}

/**
 * Runs one trusted query outside the adapter.
 *
 * For the sign-in callback and the new-user hook, which are in the same
 * position: they run during authentication, before a tenant identity exists.
 */
export function asTrusted<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return asSystem(db, fn);
}

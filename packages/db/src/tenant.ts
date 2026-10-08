import { sql } from 'drizzle-orm';
import type { Database } from './client';

/** The transaction handle `withUser` / `asSystem` hand to their callback. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Runs `fn` inside a transaction that has identified itself to Postgres, so
 * the row-level security policies from migration 0001 apply.
 *
 * Every read or write of tenant data goes through here. The `true` third
 * argument to set_config scopes the setting to the transaction, which is what
 * makes this safe on a shared connection pool: the identity cannot survive
 * into whichever request borrows the connection next.
 *
 *   const lists = await withUser(db, session.user.id, (tx) =>
 *     tx.select().from(contactLists),
 *   );
 *
 * Note there is no `where userId = ...` in that query — RLS supplies it. Keep
 * writing the explicit filter anyway where it aids the query planner; the
 * policy is the backstop, not the primary mechanism.
 */
export async function withUser<T>(
  db: Database,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!userId) throw new Error('withUser called without a user id');

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/**
 * Escape hatch for the worker's cross-tenant passes — the scheduler tick that
 * looks for due campaigns across all users, and maintenance jobs.
 *
 * RLS is FORCEd on every tenant table, including for the role that owns them,
 * so there is no implicit bypass to rely on: this sets `app.system` and the
 * `*_system_access` policies open up. Transaction-local, like app.user_id, so
 * it cannot leak into the next request on a pooled connection.
 *
 * Callers must filter explicitly — inside here Postgres will not do it for
 * them. Named to be conspicuous in review, and `app.system` is deliberately
 * greppable.
 */
export async function asSystem<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system', 'on', true)`);
    return fn(tx);
  });
}

import { redirect } from 'next/navigation';
import { withUser, type Database } from '@wa/db';
import { auth } from './auth';
import { database } from './context';

export interface Session {
  userId: string;
  email: string | null;
  name: string | null;
  image: string | null;
}

/** Returns the signed-in user, or null. */
export async function currentUser(): Promise<Session | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    userId: session.user.id,
    email: session.user.email ?? null,
    name: session.user.name ?? null,
    image: session.user.image ?? null,
  };
}

/** Use in pages and Server Actions that must not render for a guest. */
export async function requireUser(): Promise<Session> {
  const user = await currentUser();
  if (!user) redirect('/signin');
  return user;
}

/**
 * Runs a query as the signed-in user, with row-level security applied.
 *
 * This is the only sanctioned way to touch tenant data from the web tier:
 * even if a `where userId = ...` is forgotten, Postgres will not return
 * another user's rows.
 */
export async function queryAsUser<T>(
  fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0], userId: string) => Promise<T>,
): Promise<T> {
  const { userId } = await requireUser();
  return withUser(database(), userId, (tx) => fn(tx, userId));
}

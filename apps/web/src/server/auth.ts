import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import {
  authAccounts,
  authSessions,
  authenticators,
  settings,
  users,
  verificationTokens,
} from '@wa/db';
import { database, env } from './context';

/**
 * Auth.js v5 configuration.
 *
 * Database sessions rather than JWTs: a session must be revocable the moment an
 * account is suspended, and a JWT would stay valid until it expired.
 */
export const { handlers, signIn, signOut, auth } = NextAuth(() => {
  const e = env();
  const db = database();

  return {
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: authAccounts,
      sessionsTable: authSessions,
      verificationTokensTable: verificationTokens,
      authenticatorsTable: authenticators,
    }),

    secret: e.AUTH_SECRET,
    session: { strategy: 'database', maxAge: 30 * 24 * 60 * 60 },
    trustHost: true,

    providers: [
      Google({
        clientId: e.AUTH_GOOGLE_ID,
        clientSecret: e.AUTH_GOOGLE_SECRET,
        // Google is the only identity source, so nothing here needs to handle
        // account linking across providers.
        allowDangerousEmailAccountLinking: false,
      }),
    ],

    pages: {
      signIn: '/signin',
      error: '/signin',
    },

    callbacks: {
      /** A suspended user keeps their data but cannot sign in. */
      async signIn({ user }) {
        if (!user?.id) return true; // first-ever sign-in, row not created yet
        const row = await db.query.users.findFirst({
          where: (u, { eq }) => eq(u.id, user.id as string),
          columns: { suspendedAt: true },
        });
        return !row?.suspendedAt;
      },

      async session({ session, user }) {
        if (session.user) session.user.id = user.id;
        return session;
      },
    },

    events: {
      /**
       * Give every new user a settings row immediately, so the rest of the app
       * can treat it as guaranteed to exist rather than defaulting everywhere.
       */
      async createUser({ user }) {
        if (!user.id) return;
        await db.insert(settings).values({ userId: user.id }).onConflictDoNothing();
      },
    },
  };
});

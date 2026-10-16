import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import {
  authAccounts,
  authSessions,
  authenticators,
  eq,
  settings,
  users,
  verificationTokens,
} from '@wa/db';
import { database, env, logger } from './context';
import { asTrusted, canSignInByEmail, createTrustedAdapter } from './auth-adapter';

/**
 * Auth.js v5 configuration.
 *
 * Database sessions rather than JWTs: a session must be revocable the moment an
 * account is suspended, and a JWT would stay valid until it expired.
 *
 * Every database access on this path goes through the trusted helpers in
 * ./auth-adapter.ts, for the reason documented there — sign-in happens before
 * a tenant identity exists, and `users` is under FORCE row-level security.
 */
export const { handlers, signIn, signOut, auth } = NextAuth(() => {
  const e = env();
  const db = database();

  return {
    adapter: createTrustedAdapter(db, {
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
      /**
       * A suspended user keeps their data but cannot sign in.
       *
       * Fails CLOSED. The previous version returned true when the lookup came
       * back empty, which it always did under row-level security — the query
       * ran with no tenant context, matched nothing, and read as "not
       * suspended". A suspension check that cannot see the row must refuse,
       * not wave the user through.
       */
      async signIn({ user }) {
        // Auth.js also assigns an id to a NEW provider profile before the
        // database user exists. Look up the provider-verified email instead.
        if (!user.email) return false;

        try {
          return await canSignInByEmail(db, user.email);
        } catch (error) {
          logger().error('sign-in refused: suspension check failed', { error });
          return false;
        }
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
       *
       * Trusted for the same reason as the adapter: this fires during sign-in,
       * and `settings` is a tenant table under FORCE row-level security, so a
       * plain insert here is refused by the policy.
       */
      async createUser({ user }) {
        if (!user.id) return;
        try {
          await asTrusted(db, (tx) =>
            tx.insert(settings).values({ userId: user.id! }).onConflictDoNothing(),
          );
        } catch (error) {
          // Logged rather than thrown: the settings page creates the row on
          // demand as a fallback, and failing here would strand an account
          // that is otherwise fine.
          logger().error('could not create settings row for new user', {
            userId: user.id,
            error,
          });
        }
      },
    },
  };
});

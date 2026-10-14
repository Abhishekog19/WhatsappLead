import { eq } from 'drizzle-orm';
import { initAuthCreds, BufferJSON } from 'baileys';
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
} from 'baileys';
import { decryptToString, encrypt } from '@wa/core';
import { asSystem, schema, type Database } from '@wa/db';

/**
 * Baileys auth state, persisted to Postgres instead of the filesystem.
 *
 * Baileys ships `useMultiFileAuthState`, which writes a directory of JSON
 * files. That cannot work here for three reasons: the container filesystem is
 * ephemeral, a second worker would not see the first one's files, and the
 * contents are equivalent to full access to someone's WhatsApp account and so
 * must be encrypted at rest.
 *
 * Everything lives in one AES-256-GCM blob in `wa_sessions.creds_encrypted`.
 * A per-key table would avoid rewriting the whole blob on each update, but at
 * this product's volume — tens of messages a day per number — the blob stays
 * well under a megabyte and a single column keeps the "losing this means
 * re-pairing" story in one obvious place.
 *
 * Two kinds of update, written differently on purpose:
 *
 *   creds.update  fires a handful of times, and the time it matters most is
 *                 the instant a pairing completes. Written immediately.
 *   keys.set      fires several times per message as Signal sessions churn.
 *                 Coalesced, or every send becomes several encrypt-and-UPDATE
 *                 round trips.
 *
 * Debouncing the first kind is what broke pairing: WhatsApp closes the socket
 * with `restartRequired` the moment a device is linked, the reconnect read the
 * blob back before the debounced write had landed, and the fresh socket came
 * up unregistered while the phone sat on "Logging in…" forever.
 */

/** What actually gets serialised. Signal keys are grouped by type. */
interface StoredState {
  creds: AuthenticationCreds;
  keys: Record<string, Record<string, unknown>>;
}

export interface DbAuthState {
  state: AuthenticationState;
  /** Baileys calls this on `creds.update`. Writes without waiting. */
  saveCreds: () => Promise<void>;
  /** Writes anything outstanding. Call before a reconnect or shutdown. */
  flush: () => Promise<void>;
  /** Drops persisted credentials — used when WhatsApp reports a logout. */
  clear: () => Promise<void>;
}

/** Only applies to signal-key churn; credentials are never delayed. */
const KEY_WRITE_DEBOUNCE_MS = 1_000;

export async function useDbAuthState(params: {
  db: Database;
  sessionId: string;
  encryptionKey: string;
  onError?: (err: unknown) => void;
}): Promise<DbAuthState> {
  const { db, sessionId, encryptionKey, onError } = params;

  const existing = await asSystem(db, async (tx) => {
    const rows = await tx
      .select({ creds: schema.waSessions.credsEncrypted })
      .from(schema.waSessions)
      .where(eq(schema.waSessions.id, sessionId))
      .limit(1);
    return rows[0]?.creds ?? null;
  });

  let stored: StoredState;
  if (existing) {
    // BufferJSON.reviver restores the Uint8Arrays that Signal keys are made of;
    // without it every key comes back as a plain object and decryption fails
    // much later, with a confusing error.
    stored = JSON.parse(decryptToString(existing, encryptionKey), BufferJSON.reviver);
  } else {
    stored = { creds: initAuthCreds(), keys: {} };
  }

  let debounce: NodeJS.Timeout | null = null;
  // Writes are chained rather than fired in parallel: two encrypts racing to
  // UPDATE the same row can land out of order and persist older state.
  let queue: Promise<void> = Promise.resolve();

  async function write(): Promise<void> {
    const payload = encrypt(JSON.stringify(stored, BufferJSON.replacer), encryptionKey);
    await asSystem(db, async (tx) => {
      await tx
        .update(schema.waSessions)
        .set({ credsEncrypted: payload, updatedAt: new Date() })
        .where(eq(schema.waSessions.id, sessionId));
    });
  }

  function enqueue(): Promise<void> {
    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
    }
    queue = queue.then(write).catch((err) => {
      // Never throw into Baileys' event loop: a failed credential write must
      // not tear down a live socket. The next update retries it.
      onError?.(err);
    });
    return queue;
  }

  function schedule(): void {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      void enqueue();
    }, KEY_WRITE_DEBOUNCE_MS);
  }

  const state: AuthenticationState = {
    creds: stored.creds,
    keys: {
      get: (type, ids) => {
        const bucket = stored.keys[type] ?? {};
        const out: Record<string, SignalDataTypeMap[typeof type]> = {};
        for (const id of ids) {
          const value = bucket[id];
          if (value !== undefined && value !== null) {
            out[id] = value as SignalDataTypeMap[typeof type];
          }
        }
        return out;
      },
      set: (data) => {
        for (const [type, entries] of Object.entries(data)) {
          if (!entries) continue;
          const bucket = (stored.keys[type] ??= {});
          for (const [id, value] of Object.entries(entries)) {
            // Baileys signals a deletion by writing null.
            if (value === null || value === undefined) delete bucket[id];
            else bucket[id] = value;
          }
        }
        schedule();
      },
      clear: () => {
        stored.keys = {};
        schedule();
      },
    },
  };

  return {
    state,

    // Not debounced. See the note at the top of the file: the one moment this
    // has to be durable is the moment a pairing lands.
    saveCreds: () => enqueue(),

    flush: () => enqueue(),

    clear: async () => {
      if (debounce) {
        clearTimeout(debounce);
        debounce = null;
      }
      stored = { creds: initAuthCreds(), keys: {} };
      // Queued behind anything still in flight, so a late write cannot
      // resurrect the credentials we just dropped.
      queue = queue.then(async () => {
        await asSystem(db, async (tx) => {
          await tx
            .update(schema.waSessions)
            .set({ credsEncrypted: null, updatedAt: new Date() })
            .where(eq(schema.waSessions.id, sessionId));
        });
      });
      await queue;
    },
  };
}

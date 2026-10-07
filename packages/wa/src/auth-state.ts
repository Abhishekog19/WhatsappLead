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
 * Writes are coalesced: Baileys calls `keys.set` several times per message,
 * and each call would otherwise be its own encrypt-and-UPDATE round trip.
 */

/** What actually gets serialised. Signal keys are grouped by type. */
interface StoredState {
  creds: AuthenticationCreds;
  keys: Record<string, Record<string, unknown>>;
}

export interface DbAuthState {
  state: AuthenticationState;
  /** Baileys calls this on `creds.update`. Schedules a coalesced write. */
  saveCreds: () => Promise<void>;
  /** Writes immediately, bypassing the debounce. Call before shutdown. */
  flush: () => Promise<void>;
  /** Drops persisted credentials — used when WhatsApp reports a logout. */
  clear: () => Promise<void>;
}

const WRITE_DEBOUNCE_MS = 1_000;

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

  let pending: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let dirty = false;

  async function write(): Promise<void> {
    dirty = false;
    const payload = encrypt(JSON.stringify(stored, BufferJSON.replacer), encryptionKey);
    await asSystem(db, async (tx) => {
      await tx
        .update(schema.waSessions)
        .set({ credsEncrypted: payload, updatedAt: new Date() })
        .where(eq(schema.waSessions.id, sessionId));
    });
  }

  function schedule(): void {
    dirty = true;
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      inFlight = write().catch((err) => {
        // Never throw into Baileys' event loop: a failed credential write must
        // not tear down a live socket. The next update retries it.
        dirty = true;
        onError?.(err);
      });
    }, WRITE_DEBOUNCE_MS);
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

    saveCreds: async () => {
      schedule();
    },

    flush: async () => {
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
      if (inFlight) await inFlight.catch(() => undefined);
      if (dirty) await write();
    },

    clear: async () => {
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
      dirty = false;
      stored = { creds: initAuthCreds(), keys: {} };
      await asSystem(db, async (tx) => {
        await tx
          .update(schema.waSessions)
          .set({ credsEncrypted: null, updatedAt: new Date() })
          .where(eq(schema.waSessions.id, sessionId));
      });
    },
  };
}

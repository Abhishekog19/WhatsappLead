import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type WAVersion,
} from 'baileys';
import {
  fromWhatsAppJid,
  toWhatsAppJid,
  type Logger,
  type ThrottleSignal,
} from '@wa/core';
import type { Database } from '@wa/db';
import { useDbAuthState, type DbAuthState } from './auth-state';
import { baileysLogger } from './logger-adapter';

/**
 * One linked WhatsApp number, as a long-lived socket.
 *
 * Lives only in the worker. The web tier must never construct one: WhatsApp
 * allows a single active connection per linked device, and Next.js may run
 * several processes, so two sockets for one number would fight and
 * eventually get the number logged out.
 *
 * The whole lifecycle is driven through callbacks rather than an EventEmitter
 * so that TypeScript actually checks the payloads, and so a missed handler is
 * a compile error rather than a silently dropped event.
 */

export type WaStatus =
  | 'pending'
  | 'pairing'
  | 'connected'
  | 'disconnected'
  | 'logged_out'
  | 'throttled'
  | 'banned';

export interface WaHandlers {
  /** Any status transition, including the ones below. */
  onStatus(status: WaStatus, detail?: string): void | Promise<void>;
  onPairingCode(code: string, expiresAt: Date): void | Promise<void>;
  onQr(payload: string, expiresAt: Date): void | Promise<void>;
  onConnected(phoneE164: string | null): void | Promise<void>;
  /** WhatsApp asked us to slow down. Never reconnect in response. */
  onThrottle(signal: ThrottleSignal, raw: unknown): void | Promise<void>;
  onInboundMessage(msg: {
    fromE164: string;
    body: string;
    waMessageId: string;
    at: Date;
  }): void | Promise<void>;
  onReceipt(r: {
    waMessageId: string;
    type: 'delivered' | 'read';
    toE164: string;
  }): void | Promise<void>;
}

export interface WaConnectionOptions {
  db: Database;
  sessionId: string;
  userId: string;
  encryptionKey: string;
  log: Logger;
  handlers: WaHandlers;
  /** Routes Baileys' own wire logging; 'debug' is very loud. */
  logLevel?: string;
}

export interface SendTextResult {
  waMessageId: string;
  sentAt: Date;
}

/** Reconnect backoff: 5s, 10s, 20s, 40s, 80s, then every 2 minutes. */
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 120_000;

/**
 * How long each linking artefact is offered for.
 *
 * Both are tied to Baileys' registration attempt, and `qrTimeout` is how
 * often that attempt is renewed. A renewal invalidates whatever was issued
 * under the previous one — which is why these are not independent numbers:
 * showing a pairing code for 150 seconds while the registration renews every
 * 60 would hand the user a dead code and no way to know it.
 *
 * So the registration window is stretched for the pairing-code flow, and the
 * displayed deadline is set comfortably inside it. The QR flow keeps the
 * shorter refresh, because a QR on screen is meant to rotate.
 */
const PAIRING_REGISTRATION_MS = 180_000;
const PAIRING_CODE_TTL_MS = 150_000;
const QR_REFRESH_MS = 60_000;
const QR_TTL_MS = QR_REFRESH_MS;

/** Floor between pairing-code requests, so a chatty socket cannot spam them. */
const PAIRING_REQUEST_FLOOR_MS = 30_000;

export class WaConnection {
  private sock: WASocket | null = null;
  private auth: DbAuthState | null = null;
  private readonly log: Logger;

  private _status: WaStatus = 'pending';
  private closing = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** Set when the caller wants a pairing code on the next QR opportunity. */
  private pairingPhone: string | null = null;
  private pairingRequested = false;
  private lastPairingRequestAt = 0;

  constructor(private readonly opts: WaConnectionOptions) {
    this.log = opts.log.child({ sessionId: opts.sessionId });
  }

  get status(): WaStatus {
    return this._status;
  }

  get isConnected(): boolean {
    return this._status === 'connected' && this.sock !== null;
  }

  /**
   * Opens the socket. Safe to call once; use {@link close} before re-opening.
   *
   * @param pairingPhone E.164 number to request a pairing code for. Pass this
   *   only when linking by code — an already-registered session ignores it,
   *   and a QR link does not need it.
   */
  async open(pairingPhone?: string | null): Promise<void> {
    if (this.sock) throw new Error('Connection already open');
    this.closing = false;
    this.pairingPhone = pairingPhone ?? null;
    this.pairingRequested = false;
    this.lastPairingRequestAt = 0;

    // Read from the database only once per connection object. A reconnect
    // reuses the live state, which is what makes pairing work at all:
    // WhatsApp closes the socket with `restartRequired` the instant a device
    // links, and re-reading the blob here would race the write that persists
    // the new credentials. The socket would come back unregistered and the
    // phone would sit on "Logging in…" forever.
    if (!this.auth) {
      this.auth = await useDbAuthState({
        db: this.opts.db,
        sessionId: this.opts.sessionId,
        encryptionKey: this.opts.encryptionKey,
        onError: (err) => this.log.error('failed to persist auth state', { error: err }),
      });
    }

    const version = await latestVersion(this.log);
    const blog = baileysLogger(this.log, this.opts.logLevel ?? 'silent');

    this.sock = makeWASocket({
      version,
      logger: blog,
      auth: {
        creds: this.auth.state.creds,
        // The cache saves a decrypt-and-parse of the signal store on every
        // message; without it, sending is noticeably slower as keys accumulate.
        keys: makeCacheableSignalKeyStore(this.auth.state.keys, blog),
      },
      // Identifies as a desktop browser. A mobile descriptor here is what
      // triggers WhatsApp's "unsupported client" checks.
      browser: Browsers.ubuntu('Chrome'),

      // Do not flip the user's phone to "online" — that would silently stop
      // their real notifications while a campaign runs.
      markOnlineOnConnect: false,

      // Do not ASK for the full history: that is a large download this product
      // has no use for, since it only sends and watches for replies.
      syncFullHistory: false,

      // But do process the initial sync that arrives anyway. Refusing it with
      // `shouldSyncHistoryMessage: () => false` looks like the obvious
      // companion to the line above, and Baileys warns against it in capitals:
      // that notification is what carries the initial LID mappings, and
      // without them the library is left guessing how to address accounts —
      // "instability and session errors", which for a sender means messages
      // that fail or go to the wrong place.
      //
      // With syncFullHistory off, what WhatsApp sends is a recent slice rather
      // than everything, so the cost of accepting it is small and the cost of
      // refusing it is a class of bug that would be very hard to trace back
      // here.

      generateHighQualityLinkPreview: false,
      // Longer for a pairing code: the user is reading eight characters off
      // one screen and typing them into another, and a renewal mid-way would
      // silently kill the code they are holding.
      qrTimeout: this.pairingPhone ? PAIRING_REGISTRATION_MS : QR_REFRESH_MS,
      connectTimeoutMs: 45_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,

      // Returning undefined declines to re-send a message the peer failed to
      // decrypt. Re-sending outreach on a decryption retry risks a duplicate,
      // which matters more here than a rare undelivered message.
      getMessage: async () => undefined,
    });

    this.sock.ev.on('creds.update', () => {
      void this.auth?.saveCreds();
    });

    this.sock.ev.on('connection.update', (update) => {
      void this.handleConnectionUpdate(update).catch((err) =>
        this.log.error('connection.update handler failed', { error: err }),
      );
    });

    this.sock.ev.on('messages.upsert', (payload) => {
      void this.handleMessages(payload).catch((err) =>
        this.log.error('messages.upsert handler failed', { error: err }),
      );
    });

    this.sock.ev.on('messages.update', (updates) => {
      void this.handleReceipts(updates).catch((err) =>
        this.log.error('messages.update handler failed', { error: err }),
      );
    });
  }

  private async handleConnectionUpdate(
    update: Partial<{
      connection: string;
      lastDisconnect: { error?: Error | undefined; date: Date } | undefined;
      qr: string;
      isNewLogin: boolean;
    }>,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // A QR event means the socket is ready to be linked, and also that the
      // registration attempt has just been renewed. The code is requested
      // here rather than on a timer because asking before the socket is ready
      // fails with a generic error.
      if (this.pairingPhone) {
        // Re-request on a renewal rather than letting the old code rot: the
        // previous one stopped working the moment this event fired, so
        // handing the user a fresh one beats showing a dead one.
        const since = Date.now() - this.lastPairingRequestAt;
        if (!this.pairingRequested || since > PAIRING_REQUEST_FLOOR_MS) {
          this.pairingRequested = true;
          this.lastPairingRequestAt = Date.now();
          await this.requestPairingCode(this.pairingPhone);
        }
      } else {
        await this.setStatus('pairing');
        await this.opts.handlers.onQr(qr, new Date(Date.now() + QR_TTL_MS));
      }
      return;
    }

    if (connection === 'open') {
      this.reconnectAttempt = 0;
      const jid = this.sock?.user?.id ?? null;
      const phone = jid ? fromWhatsAppJid(jid) : null;
      await this.setStatus('connected');
      await this.opts.handlers.onConnected(phone);
      this.log.info('whatsapp connected', { phone: phone ?? undefined });
      return;
    }

    if (connection === 'close') {
      await this.handleClose(lastDisconnect?.error);
    }
  }

  private async handleClose(error: Error | undefined): Promise<void> {
    const statusCode = extractStatusCode(error);
    const throttle = classifyThrottle(error, statusCode);

    // Socket is dead either way; drop it before deciding what happens next.
    this.sock = null;

    if (this.closing) {
      this.log.debug('socket closed during shutdown');
      return;
    }

    if (throttle) {
      // The single most important rule in the whole engine: a throttle signal
      // means slow down, not reconnect. Re-pairing or reconnecting in
      // response is what turns a temporary cap into a ban.
      this.log.warn('throttle signal from whatsapp', { signal: throttle, statusCode });
      await this.setStatus('throttled', throttle);
      await this.opts.handlers.onThrottle(throttle, serialiseError(error));
      return;
    }

    switch (statusCode) {
      case DisconnectReason.loggedOut:
      case DisconnectReason.multideviceMismatch: {
        // The user unlinked us from their phone. The credentials are dead;
        // keeping them would only produce repeated failed reconnects.
        this.log.warn('session logged out by the user', { statusCode });
        await this.auth?.clear();
        await this.setStatus('logged_out', 'Unlinked from the phone');
        return;
      }

      case DisconnectReason.forbidden: {
        this.log.error('account forbidden by whatsapp', { statusCode });
        await this.setStatus('banned', 'WhatsApp rejected this account');
        return;
      }

      case DisconnectReason.connectionReplaced: {
        // Another client took the slot. Reconnecting would start a fight that
        // ends with WhatsApp logging both out.
        this.log.warn('connection replaced by another client');
        await this.setStatus('disconnected', 'Another device took over the session');
        return;
      }

      case DisconnectReason.restartRequired: {
        // Expected immediately after a successful pairing: Baileys asks for a
        // clean restart with the new credentials.
        //
        // Flushing first is belt and braces. The in-memory auth state carries
        // across the reopen, so the reconnect does not depend on this write —
        // but if the process dies in the next second, the user would have to
        // pair again, and they have already done their part.
        await this.auth?.flush().catch((err) =>
          this.log.error('failed to flush auth state before restart', { error: err }),
        );
        this.log.info('restart required, reconnecting now');
        await this.reopen(0);
        return;
      }

      default: {
        await this.setStatus('disconnected', error?.message);
        await this.reopen(this.nextBackoffMs());
      }
    }
  }

  private nextBackoffMs(): number {
    const ms = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt += 1;
    // Jitter so several sessions dropped by the same network blip do not all
    // come back at the same instant.
    return ms + Math.floor(Math.random() * 2_000);
  }

  private async reopen(delayMs: number): Promise<void> {
    if (this.closing) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.log.info('scheduling reconnect', { delayMs, attempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Not passing pairingPhone: a reconnect uses the stored credentials. If
      // those are gone the socket will emit a QR and the user re-links.
      void this.open().catch((err) => {
        this.log.error('reconnect failed', { error: err });
        void this.reopen(this.nextBackoffMs());
      });
    }, delayMs);
  }

  /** Asks WhatsApp for an 8-character code the user types into their phone. */
  private async requestPairingCode(phoneE164: string): Promise<void> {
    if (!this.sock) throw new Error('Socket is not open');
    // Digits only, with country code and no plus — the format the API wants.
    const digits = phoneE164.replace(/\D/g, '');

    try {
      const code = await this.sock.requestPairingCode(digits);
      const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
      await this.setStatus('pairing');
      await this.opts.handlers.onPairingCode(formatPairingCode(code), expiresAt);
      this.log.info('pairing code issued', { expiresAt });
    } catch (err) {
      this.log.error('failed to request pairing code', { error: err });
      await this.setStatus('disconnected', 'Could not get a pairing code');
      throw err;
    }
  }

  private async handleMessages(payload: {
    messages: readonly {
      key: { remoteJid?: string | null; fromMe?: boolean | null; id?: string | null };
      message?: unknown;
      messageTimestamp?: number | Long | null;
      pushName?: string | null;
    }[];
    type: string;
  }): Promise<void> {
    if (payload.type !== 'notify') return;

    for (const m of payload.messages) {
      if (m.key.fromMe) continue;
      const jid = m.key.remoteJid;
      // Groups, broadcasts and status updates are not replies to outreach.
      if (!jid || !jid.endsWith('@s.whatsapp.net')) continue;

      const body = extractText(m.message);
      if (!body) continue;

      await this.opts.handlers.onInboundMessage({
        fromE164: fromWhatsAppJid(jid),
        body: body.slice(0, 2_000),
        waMessageId: m.key.id ?? '',
        at: toDate(m.messageTimestamp),
      });
    }
  }

  private async handleReceipts(
    updates: readonly {
      key: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null };
      update: { status?: number | null };
    }[],
  ): Promise<void> {
    for (const u of updates) {
      if (!u.key.fromMe || !u.key.id || !u.key.remoteJid) continue;
      // Baileys' WAMessageStatus: 3 = delivered to device, 4 = read.
      const status = u.update.status;
      const type = status === 4 ? 'read' : status === 3 ? 'delivered' : null;
      if (!type) continue;

      await this.opts.handlers.onReceipt({
        waMessageId: u.key.id,
        type,
        toE164: fromWhatsAppJid(u.key.remoteJid),
      });
    }
  }

  /**
   * Sends one text message, optionally preceded by a typing indicator.
   *
   * The presence sequence is what a person's client does: subscribe, show
   * "typing…" for a while, stop, then send. Skipping it is one of the
   * cheapest ways to look automated.
   */
  async sendText(
    phoneE164: string,
    text: string,
    options: { typingMs?: number } = {},
  ): Promise<SendTextResult> {
    const sock = this.sock;
    if (!sock || this._status !== 'connected') {
      throw new Error(`Cannot send while status is "${this._status}"`);
    }

    const jid = toWhatsAppJid(phoneE164);
    const typingMs = options.typingMs ?? 0;

    if (typingMs > 0) {
      try {
        await sock.presenceSubscribe(jid);
        await sock.sendPresenceUpdate('composing', jid);
        await delay(typingMs);
        await sock.sendPresenceUpdate('paused', jid);
      } catch (err) {
        // Presence is cosmetic. Losing it must not cost us the message.
        this.log.debug('presence update failed', { error: err });
      }
    }

    const sent = await sock.sendMessage(jid, { text });
    if (!sent?.key?.id) {
      throw new Error('WhatsApp accepted the message but returned no id');
    }

    return { waMessageId: sent.key.id, sentAt: new Date() };
  }

  /**
   * Asks WhatsApp which of these numbers are registered.
   *
   * Worth doing before a campaign: sending to an unregistered number is a
   * wasted send that still counts against the daily quota, and a high rate of
   * them is itself a spam signal.
   */
  async checkOnWhatsApp(
    numbers: readonly string[],
  ): Promise<Map<string, boolean>> {
    const sock = this.sock;
    if (!sock || this._status !== 'connected') {
      throw new Error(`Cannot query while status is "${this._status}"`);
    }

    const out = new Map<string, boolean>();
    if (numbers.length === 0) return out;

    const results = await sock.onWhatsApp(...numbers.map((n) => n.replace(/^\+/, '')));
    for (const r of results ?? []) {
      if (!r?.jid) continue;
      out.set(fromWhatsAppJid(r.jid), Boolean(r.exists));
    }
    // Anything WhatsApp did not answer for is absent, not unknown.
    for (const n of numbers) if (!out.has(n)) out.set(n, false);
    return out;
  }

  /** Unlinks this device from the user's phone and discards credentials. */
  async logout(): Promise<void> {
    this.closing = true;
    try {
      await this.sock?.logout();
    } catch (err) {
      // An already-dead socket cannot log out, and that is fine — the point
      // is to destroy the local credentials, which happens either way.
      this.log.debug('logout call failed', { error: err });
    }
    await this.auth?.clear();
    // Dropped so a later re-link starts from the database, which clear() has
    // just emptied, rather than from an in-memory object this one still holds.
    this.auth = null;
    await this.teardown();
    await this.setStatus('logged_out', 'Unlinked by the user');
  }

  /** Stops the socket without unlinking. Credentials survive for a restart. */
  async close(): Promise<void> {
    this.closing = true;
    await this.auth?.flush();
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.sock?.end(undefined);
    } catch {
      // end() throws if the socket is already gone; nothing to do about it.
    }
    this.sock = null;
  }

  private async setStatus(status: WaStatus, detail?: string): Promise<void> {
    if (this._status === status) return;
    this._status = status;
    await this.opts.handlers.onStatus(status, detail);
  }
}

// ---------------------------------------------------------------------------

/**
 * WhatsApp's current client version, cached process-wide.
 *
 * Pinning to it avoids the "outdated client" disconnect, and it is fetched
 * rather than hard-coded because the server rejects versions that have fallen
 * too far behind. Cached because a reconnect must not wait on a network round
 * trip — during a backoff storm that would be one fetch per attempt per
 * session — and because a stale-but-recent version beats failing to open at
 * all when the lookup is unreachable.
 */
let cachedVersion: { value: WAVersion; fetchedAt: number } | null = null;
const VERSION_TTL_MS = 6 * 60 * 60 * 1_000;

async function latestVersion(log: Logger): Promise<WAVersion> {
  if (cachedVersion && Date.now() - cachedVersion.fetchedAt < VERSION_TTL_MS) {
    return cachedVersion.value;
  }
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = { value: version, fetchedAt: Date.now() };
    return version;
  } catch (err) {
    if (cachedVersion) {
      log.warn('could not refresh the WhatsApp version, using the cached one', {
        error: err,
      });
      return cachedVersion.value;
    }
    throw err;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Boom errors from Baileys carry the WhatsApp status code here. */
function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const output = (error as { output?: { statusCode?: unknown } }).output;
  const code = output?.statusCode ?? (error as { statusCode?: unknown }).statusCode;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Maps a disconnect to one of the four signals the safety governor knows.
 *
 * WhatsApp does not document these. 475 and 463 are the codes observed when
 * an account exceeds its new-conversation quota and when it is shadow
 * restricted; the string checks catch the stanza-level `rate-overlimit`
 * errors that arrive without a numeric code. Anything unrecognised returns
 * null and is treated as an ordinary disconnect — the raw payload is stored
 * on the throttle_events row so a new signal can be identified later rather
 * than being silently misfiled as one we already know.
 */
export function classifyThrottle(
  error: unknown,
  statusCode?: number,
): ThrottleSignal | null {
  const code = statusCode ?? extractStatusCode(error);
  if (code === 475) return 'capped_475';
  if (code === 463) return 'shadow_463';
  if (code === 429) return 'capped_475';

  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (!message) return null;
  if (message.includes('rate-overlimit') || message.includes('rate overlimit')) {
    return 'capped_475';
  }
  if (message.includes('temporarily blocked') || message.includes('restricted')) {
    return 'shadow_463';
  }
  return null;
}

function serialiseError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: String(error) };
  return {
    name: error.name,
    message: error.message,
    statusCode: extractStatusCode(error) ?? null,
    data: (error as { data?: unknown }).data ?? null,
  };
}

/** WhatsApp returns "ABCD1234"; the UI shows "ABCD-1234" to make it readable. */
function formatPairingCode(code: string): string {
  const clean = code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

type Long = { toNumber(): number };

function toDate(ts: number | Long | null | undefined): Date {
  if (typeof ts === 'number') return new Date(ts * 1_000);
  if (ts && typeof ts === 'object' && 'toNumber' in ts) {
    return new Date(ts.toNumber() * 1_000);
  }
  return new Date();
}

/** Pulls plain text out of the handful of message shapes we care about. */
function extractText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as Record<string, { text?: string; caption?: string } | string>;

  if (typeof m.conversation === 'string') return m.conversation;

  const extended = m.extendedTextMessage;
  if (extended && typeof extended === 'object' && extended.text) return extended.text;

  for (const key of ['imageMessage', 'videoMessage', 'documentMessage'] as const) {
    const media = m[key];
    if (media && typeof media === 'object' && media.caption) return media.caption;
  }

  const buttons = m.buttonsResponseMessage as { selectedDisplayText?: string } | undefined;
  if (buttons?.selectedDisplayText) return buttons.selectedDisplayText;

  const list = m.listResponseMessage as { title?: string } | undefined;
  if (list?.title) return list.title;

  return null;
}

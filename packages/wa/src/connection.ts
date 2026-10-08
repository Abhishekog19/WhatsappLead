import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
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
 * How long a pairing code is offered for. WhatsApp's own window is shorter
 * and undocumented; this is the deadline the UI counts down to before telling
 * the user to request a fresh one.
 */
const PAIRING_CODE_TTL_MS = 150_000;
const QR_TTL_MS = 60_000;

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
   *   only when linking a new number — an already-registered session ignores it.
   */
  async open(pairingPhone?: string | null): Promise<void> {
    if (this.sock) throw new Error('Connection already open');
    this.closing = false;
    this.pairingPhone = pairingPhone ?? null;
    this.pairingRequested = false;

    this.auth = await useDbAuthState({
      db: this.opts.db,
      sessionId: this.opts.sessionId,
      encryptionKey: this.opts.encryptionKey,
      onError: (err) => this.log.error('failed to persist auth state', { error: err }),
    });

    // Pinning to WhatsApp's current version avoids the "outdated client"
    // disconnect; this is fetched rather than hard-coded because the server
    // rejects versions that have fallen too far behind.
    const { version } = await fetchLatestBaileysVersion();
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

      // We never read old chats, only send and watch for replies. Skipping
      // history sync saves a large download and a lot of memory per session.
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,

      generateHighQualityLinkPreview: false,
      qrTimeout: QR_TTL_MS,
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
      // A QR means the socket is ready to be linked. For the pairing-code
      // flow we ask for the code here rather than on a timer, because
      // requesting before the socket is ready fails with a generic error.
      if (this.pairingPhone && !this.pairingRequested) {
        this.pairingRequested = true;
        await this.requestPairingCode(this.pairingPhone);
      } else if (!this.pairingPhone) {
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

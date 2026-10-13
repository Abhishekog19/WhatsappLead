import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  type AuthenticationState,
  type SignalDataTypeMap,
} from 'baileys';
import type { ILogger } from 'baileys/lib/Utils/logger';

/**
 * Opens one WhatsApp socket and narrates everything it does.
 *
 * Run with:
 *   npm run probe --workspace=@wa/wa -- +919876543210
 *   npm run probe --workspace=@wa/wa            (QR instead of a code)
 *
 * Diagnostic only. Credentials are held in memory and thrown away, so this
 * never touches the database and cannot collide with a running worker — which
 * matters, because WhatsApp allows one connection per linked device and the
 * usual symptom of two is both being logged out.
 *
 * It exists because of how little the platform can see when linking fails.
 * The worker reports a clean tick either way: the socket is opened inside a
 * job that catches, the interesting events are asynchronous, and a socket that
 * dies before emitting anything leaves no trace but an unchanged row. This
 * prints the event stream, so "no code appeared" becomes a specific answer —
 * no QR event, a rejected pairing request, a version mismatch, a closed
 * connection with a status code.
 */

const RUN_FOR_MS = 60_000;

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function say(msg: string, detail?: unknown): void {
  const extra =
    detail === undefined
      ? ''
      : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[${stamp()}] ${msg}${extra}`);
}

/** Baileys' own wire logging, at whatever level is asked for. */
function wireLogger(level: string): ILogger {
  const show = level === 'debug' || level === 'trace';
  const emit = (tag: string, obj: unknown, msg?: string): void => {
    const text = msg ?? '';
    const body = obj && typeof obj === 'object' ? JSON.stringify(obj).slice(0, 300) : String(obj ?? '');
    console.log(`[${stamp()}]   baileys/${tag} ${text} ${body}`.trimEnd());
  };
  const make = (): ILogger => ({
    level,
    child: () => make(),
    trace: () => undefined,
    debug: (o, m) => show && emit('debug', o, m),
    info: (o, m) => show && emit('info', o, m),
    warn: (o, m) => emit('warn', o, m),
    error: (o, m) => emit('error', o, m),
  });
  return make();
}

/** In-memory auth state: nothing persists, nothing is decrypted from the DB. */
function memoryAuth(): AuthenticationState {
  const keys: Record<string, Record<string, unknown>> = {};
  return {
    creds: initAuthCreds(),
    keys: {
      get: (type, ids) => {
        const bucket = keys[type] ?? {};
        const out: Record<string, SignalDataTypeMap[typeof type]> = {};
        for (const id of ids) {
          const v = bucket[id];
          if (v !== undefined && v !== null) out[id] = v as SignalDataTypeMap[typeof type];
        }
        return out;
      },
      set: (data) => {
        for (const [type, entries] of Object.entries(data)) {
          if (!entries) continue;
          const bucket = (keys[type] ??= {});
          for (const [id, value] of Object.entries(entries)) {
            if (value === null || value === undefined) delete bucket[id];
            else bucket[id] = value;
          }
        }
      },
    },
  };
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  const phone = raw ? raw.replace(/\D/g, '') : null;
  const level = process.env.LOG_LEVEL ?? 'warn';

  say(phone ? `Pairing-code probe for +${phone}` : 'QR probe (no number given)');
  say(`Baileys wire logging: ${level} (set LOG_LEVEL=debug for everything)`);

  const { version, isLatest } = await fetchLatestBaileysVersion();
  say('WhatsApp client version', { version: version.join('.'), isLatest });

  const auth = memoryAuth();
  const blog = wireLogger(level);

  const sock = makeWASocket({
    version,
    logger: blog,
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, blog) },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    // Matches the worker: do not ask for the full history, but do accept the
    // initial sync, which is what carries the LID mappings.
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    // Matches the worker: longer for a code, so the registration attempt is
    // not renewed while someone is typing.
    qrTimeout: phone ? 180_000 : 60_000,
    connectTimeoutMs: 45_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    getMessage: async () => undefined,
  });

  say('socket constructed, waiting for events…');

  let qrSeen = 0;
  let requested = false;

  sock.ev.on('creds.update', () => {
    say('creds.update', { registered: auth.creds.registered });
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } =
      update;

    if (connection) say('connection.update', { connection, isNewLogin, receivedPendingNotifications });

    if (qr) {
      qrSeen += 1;
      say(`QR event #${qrSeen}`, { payloadChars: qr.length });

      if (phone && !requested) {
        requested = true;
        say('requesting a pairing code…');
        sock
          .requestPairingCode(phone)
          .then((code) => say('PAIRING CODE', code))
          .catch((err) =>
            say('requestPairingCode FAILED', {
              message: err instanceof Error ? err.message : String(err),
              statusCode: statusCodeOf(err),
            }),
          );
      }
    }

    if (connection === 'close') {
      const code = statusCodeOf(lastDisconnect?.error);
      say('connection closed', {
        statusCode: code,
        reason: code ? reasonName(code) : 'unknown',
        message: lastDisconnect?.error?.message,
      });
    }

    if (connection === 'open') {
      say('CONNECTED', { user: sock.user?.id });
    }
  });

  setTimeout(() => {
    say('--- summary ---');
    say(`QR events seen: ${qrSeen}`);
    say(`pairing code requested: ${requested}`);
    if (qrSeen === 0) {
      say(
        'No QR event arrived. The socket never reached the point where a code ' +
          'can be requested — look at the close status code above, and try ' +
          'LOG_LEVEL=debug.',
      );
    }
    try {
      sock.end(undefined);
    } catch {
      // Already gone.
    }
    process.exit(0);
  }, RUN_FOR_MS);
}

function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const out = (error as { output?: { statusCode?: unknown } }).output;
  const code = out?.statusCode ?? (error as { statusCode?: unknown }).statusCode;
  return typeof code === 'number' ? code : undefined;
}

function reasonName(code: number): string {
  for (const [name, value] of Object.entries(DisconnectReason)) {
    if (value === code && Number.isNaN(Number(name))) return name;
  }
  return String(code);
}

main().catch((err) => {
  say('probe crashed', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});

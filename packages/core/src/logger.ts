/**
 * Structured logging.
 *
 * Every line is one JSON object so the Oracle host can ship logs straight to
 * `docker logs` / journald without a parser. Two rules matter here:
 *   - Phone numbers are personal data; they are masked unless the log level
 *     is explicitly `debug`.
 *   - Credentials and tokens are never logged, at any level.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Keys whose values are dropped entirely, matched case-insensitively. */
const SECRET_KEYS = [
  'creds',
  'credsencrypted',
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'authsecret',
  'apikey',
  'cookie',
  'authorization',
  'credsencryptionkey',
];

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  /** Returns a logger that merges `ctx` into every subsequent line. */
  child(ctx: LogContext): Logger;
}

/** "+919876543210" -> "+9198****3210" */
export function maskPhone(value: string): string {
  const plus = value.startsWith('+') ? '+' : '';
  const digits = value.replace(/\D/g, '');
  if (digits.length < 8) return `${plus}${'*'.repeat(digits.length)}`;
  return `${plus}${digits.slice(0, 4)}${'*'.repeat(digits.length - 8)}${digits.slice(-4)}`;
}

function redact(value: unknown, unmaskPhones: boolean, depth = 0): unknown {
  if (depth > 6) return '[depth]';

  if (typeof value === 'string') {
    if (unmaskPhones) return value;
    // Catch phone numbers embedded in free text (JIDs, error messages).
    return value.replace(/\+?\d[\d\s\-().]{7,}\d/g, (m) => maskPhone(m));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message, unmaskPhones, depth + 1),
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, unmaskPhones, depth + 1));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.includes(k.toLowerCase().replace(/[_-]/g, ''))) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = redact(v, unmaskPhones, depth + 1);
    }
    return out;
  }

  return value;
}

export function createLogger(
  options: { level?: LogLevel; base?: LogContext; stream?: NodeJS.WritableStream } = {},
): Logger {
  const level = options.level ?? 'info';
  const base = options.base ?? {};
  const stream = options.stream ?? process.stdout;
  const threshold = LEVEL_ORDER[level];
  const unmaskPhones = level === 'debug';

  function emit(lvl: LogLevel, msg: string, ctx?: LogContext): void {
    if (LEVEL_ORDER[lvl] < threshold) return;

    const line = {
      t: new Date().toISOString(),
      level: lvl,
      msg,
      ...(redact({ ...base, ...ctx }, unmaskPhones) as LogContext),
    };

    try {
      stream.write(`${JSON.stringify(line)}\n`);
    } catch {
      // A logger must never take the process down.
      stream.write(`{"t":"${line.t}","level":"error","msg":"log serialisation failed"}\n`);
    }
  }

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (ctx) => createLogger({ ...options, base: { ...base, ...ctx } }),
  };
}

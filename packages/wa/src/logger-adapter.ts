import type { ILogger } from 'baileys/lib/Utils/logger';
import type { Logger } from '@wa/core';

/**
 * Adapts our structured logger to the interface Baileys expects.
 *
 * Baileys is extremely chatty — it traces every node on the wire, including
 * message contents and key material — so everything below `warn` is dropped
 * unless the process is explicitly running at debug level. The alternative,
 * pulling in pino just to silence it, is a dependency for nothing.
 */
export function baileysLogger(log: Logger, level: string = 'silent'): ILogger {
  const enabled = level === 'debug' || level === 'trace';

  const toContext = (obj: unknown): Record<string, unknown> =>
    obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : { detail: obj };

  const make = (base: Record<string, unknown>): ILogger => ({
    level,
    child: (obj) => make({ ...base, ...obj }),
    trace: () => undefined,
    debug: (obj, msg) => {
      if (enabled) log.debug(msg ?? 'baileys', { ...base, ...toContext(obj) });
    },
    info: (obj, msg) => {
      if (enabled) log.debug(msg ?? 'baileys', { ...base, ...toContext(obj) });
    },
    // Warnings and errors always surface: these are the lines that explain a
    // dropped connection at 3am.
    warn: (obj, msg) => log.warn(msg ?? 'baileys', { ...base, ...toContext(obj) }),
    error: (obj, msg) => log.error(msg ?? 'baileys', { ...base, ...toContext(obj) }),
  });

  return make({ engine: 'baileys' });
}

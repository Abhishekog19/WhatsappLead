/**
 * @wa/wa — the WhatsApp engine.
 *
 * Only the worker imports this. Opening a socket from the web tier would
 * create a second connection for the same linked device, which WhatsApp
 * resolves by logging both out.
 */

export { WaConnection, classifyThrottle } from './connection';
export type {
  WaStatus,
  WaHandlers,
  WaConnectionOptions,
  SendTextResult,
} from './connection';

export { WaManager, listResumableSessions } from './manager';
export { useDbAuthState } from './auth-state';
export type { DbAuthState } from './auth-state';
export { detectOptOut } from './opt-out';

import { loadEnv } from '@wa/core';
let active = 0;
export class ImportBusyError extends Error {
  constructor() { super('Another import is running. Try again shortly.'); }
}
// Reject rather than queue: queued multipart requests also retain memory.
export async function withImportSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= loadEnv().MAX_CONCURRENT_IMPORTS) throw new ImportBusyError();
  active++;
  try { return await work(); } finally { active--; }
}
export function importLoad() { return { active, waiting: 0 }; }

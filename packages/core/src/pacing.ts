import { DEFAULT_PACING } from './safety';

/**
 * Human-like pacing.
 *
 * The goal is not to look random — it is to look like a person who picks up
 * their phone, types for a bit, sends, gets distracted, and comes back later.
 * Three things give an automated sender away, and each has a countermeasure
 * here:
 *
 *   - a constant gap between messages          -> randomised delay
 *   - instant sends with no typing indicator   -> duration scaled to length
 *   - sending steadily for eight hours         -> batches and long pauses
 */

export interface PacingConfig {
  minDelayMs: number;
  maxDelayMs: number;
  batchSize: number;
  minBatchPauseMs: number;
  maxBatchPauseMs: number;
  simulateTyping: boolean;
}

export interface SendWindow {
  startHour: number;
  endHour: number;
  timezone: string;
  skipWeekends: boolean;
}

/**
 * Gap before the next message.
 *
 * `multiplier` comes from the session's `delayMultiplier`, which the governor
 * raises after a warning from WhatsApp. Slowing down is the only correct
 * response to being told you are going too fast.
 */
export function nextDelayMs(
  pacing: Pick<PacingConfig, 'minDelayMs' | 'maxDelayMs'>,
  multiplier = 1,
  rand: () => number = Math.random,
): number {
  const min = Math.max(1_000, pacing.minDelayMs);
  const max = Math.max(min + 1_000, pacing.maxDelayMs);
  return Math.round((min + rand() * (max - min)) * Math.max(1, multiplier));
}

/** Pause after finishing a batch, before starting the next one. */
export function nextBatchPauseMs(
  pacing: Pick<PacingConfig, 'minBatchPauseMs' | 'maxBatchPauseMs'>,
  rand: () => number = Math.random,
): number {
  const min = Math.max(60_000, pacing.minBatchPauseMs);
  const max = Math.max(min + 60_000, pacing.maxBatchPauseMs);
  return Math.round(min + rand() * (max - min));
}

/**
 * How long to show "typing…" before sending.
 *
 * Derived from the message length at roughly 45 words per minute — a brisk
 * but believable phone-typing speed — then clamped. A twelve-second typing
 * indicator for a 200-word message is realistic; two minutes is not, and
 * nobody waits that long for a cold message anyway.
 */
export function typingDurationMs(
  text: string,
  rand: () => number = Math.random,
): number {
  const words = text.trim().split(/\s+/).length;
  const baseMs = (words / 45) * 60_000;
  // ±25% so two messages of the same length do not take identical time.
  const jittered = baseMs * (0.75 + rand() * 0.5);
  return Math.round(
    Math.min(
      Math.max(jittered, DEFAULT_PACING.minTypingMs),
      DEFAULT_PACING.maxTypingMs * 3,
    ),
  );
}

/**
 * Varies the batch size by ±20%, so the pattern is not "exactly 15, pause,
 * exactly 15, pause".
 */
export function jitterBatchSize(
  batchSize: number,
  rand: () => number = Math.random,
): number {
  const spread = Math.max(1, Math.round(batchSize * 0.2));
  const delta = Math.round((rand() * 2 - 1) * spread);
  return Math.max(1, batchSize + delta);
}

/** Local wall-clock parts of `date` in an IANA timezone. */
export function localParts(
  date: Date,
  timezone: string,
): { hour: number; minute: number; weekday: number } {
  // Intl is the only way to do this correctly without shipping a tz database;
  // 'en-GB' gives a 24-hour clock so hour 0 does not come back as "24".
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });

  const parts = new Map(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return {
    hour: Number(parts.get('hour') ?? '0') % 24,
    minute: Number(parts.get('minute') ?? '0'),
    weekday: Math.max(0, weekdays.indexOf(parts.get('weekday') ?? 'Sun')),
  };
}

/** True when `date` falls inside the user's configured sending hours. */
export function isWithinSendWindow(date: Date, window: SendWindow): boolean {
  let parts: { hour: number; weekday: number };
  try {
    parts = localParts(date, window.timezone);
  } catch {
    // An invalid timezone must not silently become "send at any hour".
    parts = localParts(date, 'UTC');
  }

  if (window.skipWeekends && (parts.weekday === 0 || parts.weekday === 6)) {
    return false;
  }

  const { startHour, endHour } = window;
  // An inverted window would mean sending overnight, which no outreach should
  // do; treat it as misconfiguration and refuse rather than guessing.
  if (startHour >= endHour) return false;

  return parts.hour >= startHour && parts.hour < endHour;
}

/**
 * When the window next opens, as a Date.
 *
 * Used to tell the user "resumes at 10:00 tomorrow" instead of leaving a
 * campaign sitting at "paused" with no explanation.
 */
export function nextWindowOpensAt(from: Date, window: SendWindow): Date {
  // Minute granularity is enough, and stepping by the hour keeps this cheap
  // and obviously correct across DST changes, which an arithmetic
  // reconstruction of local midnight would not be.
  const probe = new Date(from.getTime());
  probe.setUTCMinutes(0, 0, 0);

  for (let i = 0; i < 24 * 14; i++) {
    probe.setTime(probe.getTime() + 60 * 60 * 1_000);
    if (isWithinSendWindow(probe, window)) return probe;
  }

  // Unreachable with a valid window; returning the probe beats throwing from
  // a display helper.
  return probe;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
  });
}

/**
 * Safety limits and the adaptive tier model.
 *
 * Background: WhatsApp enforces a quota on how many people you have never
 * messaged before you can contact within a MOVING 24-hour window. Exceeding
 * it blocks new conversations while leaving existing threads working.
 *
 * Two rules follow from that, and both differ from the original script:
 *   1. The window is rolling, not a calendar day. A midnight reset lets an
 *      account send 2x the cap in ~1 hour across the boundary.
 *   2. The unit is DISTINCT NEW CONTACTS, not messages. Replies into threads
 *      where the person already wrote back do not consume the budget.
 *
 * Rather than trusting a fixed constant — the real threshold varies with
 * account age, reply rate and report rate — accounts earn their ceiling,
 * mirroring how Meta's own official tiers scale.
 */

export type AccountType = 'personal' | 'business';

/** Signals WhatsApp emits as an account approaches / crosses the quota. */
export type ThrottleSignal =
  | 'first_warning'
  | 'second_warning'
  | 'capped_475'
  | 'shadow_463';

export const TIERS = [1, 2, 3, 4] as const;
export type Tier = (typeof TIERS)[number];

/** New-contact ceiling per rolling 24h, by account type and earned tier. */
export const TIER_CAPS: Record<AccountType, Record<Tier, number>> = {
  personal: { 1: 30, 2: 40, 3: 50, 4: 60 },
  business: { 1: 40, 2: 60, 3: 80, 4: 100 },
};

/**
 * Warm-up ramp for a newly linked number, indexed by day 1..7.
 * A fresh number sending at full tier on day one is the single most
 * reliable way to get capped.
 */
export const WARMUP_RAMP: Record<AccountType, readonly number[]> = {
  personal: [10, 12, 14, 16, 18, 20, 20],
  business: [10, 13, 16, 19, 22, 25, 25],
};

export const WARMUP_DAYS = 7;

/** Conditions to earn the next tier. Demotion is immediate and unconditional. */
export const PROMOTION_RULES: Record<
  Exclude<Tier, 1>,
  { cleanDays: number; minUtilisation: number; minReplyRate: number }
> = {
  2: { cleanDays: 7, minUtilisation: 0.5, minReplyRate: 0 },
  3: { cleanDays: 7, minUtilisation: 0.5, minReplyRate: 0 },
  // The top tier additionally requires evidence that real people reply —
  // volume alone is exactly the profile that gets numbers reported.
  4: { cleanDays: 14, minUtilisation: 0.5, minReplyRate: 0.05 },
};

/** How the governor reacts to each signal from WhatsApp. */
export const THROTTLE_RESPONSE: Record<
  ThrottleSignal,
  {
    tierDrop: number;
    delayMultiplier: number;
    pauseMs: number;
    resetToTier1: boolean;
    alertUser: boolean;
  }
> = {
  first_warning: {
    tierDrop: 1,
    delayMultiplier: 2,
    pauseMs: 0,
    resetToTier1: false,
    alertUser: true,
  },
  second_warning: {
    tierDrop: 2,
    delayMultiplier: 4,
    pauseMs: 0,
    resetToTier1: false,
    alertUser: true,
  },
  // Quota exhausted. Hold for a full window measured from the capping event.
  capped_475: {
    tierDrop: 0,
    delayMultiplier: 1,
    pauseMs: 24 * 60 * 60 * 1_000,
    resetToTier1: true,
    alertUser: true,
  },
  // Shadow restriction — stop and let a human look at it.
  shadow_463: {
    tierDrop: 0,
    delayMultiplier: 1,
    pauseMs: 12 * 60 * 60 * 1_000,
    resetToTier1: true,
    alertUser: true,
  },
};

/**
 * IMPORTANT: on any of these signals the session stays WORKING.
 * Restarting, logging out or re-pairing makes the situation worse —
 * the only correct response is to slow down.
 */
export const NEVER_RECONNECT_ON_THROTTLE = true;

/** Pacing defaults, carried over from the original script's tuned values. */
export const DEFAULT_PACING = {
  minDelayMs: 25_000,
  maxDelayMs: 55_000,
  batchSize: 15,
  minBatchPauseMs: 45 * 60 * 1_000,
  maxBatchPauseMs: 90 * 60 * 1_000,
  minTypingMs: 2_000,
  maxTypingMs: 5_000,
} as const;

/** Default send window — never message at 3am. Local to the user's timezone. */
export const DEFAULT_SEND_WINDOW = {
  startHour: 10,
  endHour: 19,
  timezone: 'Asia/Kolkata',
} as const;

export const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * Resolves the effective new-contact cap for an account right now.
 * Warm-up overrides tier; the platform ceiling overrides everything.
 */
export function effectiveCap(params: {
  accountType: AccountType;
  tier: Tier;
  /** Whole days since the number was linked. Day 1 is the first day. */
  daysSinceLink: number;
  warmupEnabled: boolean;
  /** User's own lower setting, if they chose to be more conservative. */
  userCap?: number | null;
  platformCeiling: number;
}): number {
  const { accountType, tier, daysSinceLink, warmupEnabled, userCap, platformCeiling } =
    params;

  let cap = TIER_CAPS[accountType][tier];

  if (warmupEnabled && daysSinceLink <= WARMUP_DAYS) {
    const ramp = WARMUP_RAMP[accountType];
    const idx = Math.max(0, Math.min(ramp.length - 1, daysSinceLink - 1));
    cap = Math.min(cap, ramp[idx] ?? cap);
  }

  // A user may always choose to send LESS than their earned tier.
  if (typeof userCap === 'number' && userCap > 0) {
    cap = Math.min(cap, userCap);
  }

  return Math.min(cap, platformCeiling);
}

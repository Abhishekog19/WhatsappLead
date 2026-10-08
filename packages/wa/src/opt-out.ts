/**
 * Opt-out detection.
 *
 * A reply that asks to be left alone is honoured immediately and permanently.
 * This is the one rule a user cannot configure away, so the matching has to
 * be careful in both directions: missing an opt-out means messaging someone
 * who asked you not to, and a false positive silently removes a lead who was
 * actually interested.
 *
 * The rules therefore anchor on short replies. "STOP" on its own is an
 * opt-out; "stop by the clinic anytime" in a 40-word reply is not.
 */

/** Matched only when the reply is essentially just this word. */
const STANDALONE = [
  'stop',
  'unsubscribe',
  'remove',
  'opt out',
  'optout',
  'no',
  'not interested',
  'no thanks',
  'no thank you',
  'leave me alone',
  'do not contact',
  "don't contact",
  'dont contact',
  'band karo',
  'band karo message',
  'mat bhejo',
  'mujhe mat bhejo',
];

/** Unambiguous anywhere in the reply, however long. */
const ANYWHERE = [
  'unsubscribe me',
  'remove me from',
  'remove my number',
  'stop messaging me',
  'stop sending me',
  'do not message me',
  "don't message me",
  'dont message me',
  'do not contact me',
  'take me off',
  'report spam',
  'this is spam',
];

const MAX_STANDALONE_WORDS = 4;

/** Returns true when the reply should permanently suppress this number. */
export function detectOptOut(body: string): boolean {
  const text = body
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return false;

  for (const phrase of ANYWHERE) {
    if (text.includes(phrase)) return true;
  }

  // Beyond a few words the reply is a sentence, and a bare keyword inside it
  // is far more likely to be ordinary English than a request to stop.
  if (text.split(' ').length > MAX_STANDALONE_WORDS) return false;

  return STANDALONE.includes(text);
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for secrets at rest — primarily the WhatsApp
 * session credentials, which are equivalent to full account access.
 *
 * Format of the stored value (all base64, dot-separated):
 *   v1.<iv>.<ciphertext>.<authTag>
 *
 * The version prefix lets us rotate algorithms later without a big-bang
 * migration: decrypt() dispatches on it.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit IV is the GCM recommendation
const VERSION = 'v1';

function keyFromBase64(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error('Encryption key must be exactly 32 bytes');
  }
  return key;
}

export function encrypt(plaintext: string | Buffer, keyB64: string): string {
  const key = keyFromBase64(keyB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);

  const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64'),
    ciphertext.toString('base64'),
    tag.toString('base64'),
  ].join('.');
}

export function decrypt(payload: string, keyB64: string): Buffer {
  const parts = payload.split('.');
  if (parts.length !== 4) {
    throw new Error('Malformed encrypted payload');
  }
  const [version, ivB64, ctB64, tagB64] = parts as [string, string, string, string];

  if (version !== VERSION) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }

  const key = keyFromBase64(keyB64);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

  // GCM verifies the auth tag inside final(); tampering throws here.
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]);
}

export function decryptToString(payload: string, keyB64: string): string {
  return decrypt(payload, keyB64).toString('utf8');
}

/** Convenience for JSON blobs such as Baileys auth state. */
export function encryptJson(value: unknown, keyB64: string): string {
  return encrypt(JSON.stringify(value), keyB64);
}

export function decryptJson<T = unknown>(payload: string, keyB64: string): T {
  return JSON.parse(decryptToString(payload, keyB64)) as T;
}

/** Generates a fresh 32-byte key, base64 — for the .env setup step. */
export function generateKey(): string {
  return randomBytes(32).toString('base64');
}

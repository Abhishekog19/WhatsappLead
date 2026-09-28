import { z } from 'zod';

/**
 * Environment contract for every process in the monorepo.
 *
 * Validated once at startup so a missing secret fails loudly on boot rather
 * than at 2am in the middle of a campaign.
 */
const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgres:// URL'),

  /**
   * AES-256-GCM key for WhatsApp credential encryption, base64, 32 bytes.
   * Losing this forces every linked account to re-pair, so it is treated as
   * a hard requirement rather than something with a dev-time default.
   */
  CREDS_ENCRYPTION_KEY: z
    .string()
    .min(1, 'CREDS_ENCRYPTION_KEY is required')
    .refine(
      (v) => {
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      },
      { message: 'CREDS_ENCRYPTION_KEY must be 32 bytes, base64-encoded' },
    ),

  AUTH_SECRET: z.string().min(16, 'AUTH_SECRET is required'),
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),

  APP_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  WORKER_TICK_MS: z.coerce.number().int().positive().default(5_000),
  /** Port the worker's own /health endpoint listens on, for the container probe. */
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().max(65_535).default(3_001),
  WA_ENGINE: z.enum(['baileys', 'wwebjs']).default('baileys'),

  PLATFORM_MAX_NEW_CONTACTS_24H: z.coerce
    .number()
    .int()
    .positive()
    .default(120),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Parses and caches process.env.
 *
 * Throws a single readable error listing every problem, instead of failing
 * one variable at a time across several restarts.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy .env.example to .env and fill in the missing values.',
    );
  }

  cached = parsed.data;
  return cached;
}

/** Test-only: drop the cache so a fresh environment can be loaded. */
export function resetEnvCache(): void {
  cached = null;
}

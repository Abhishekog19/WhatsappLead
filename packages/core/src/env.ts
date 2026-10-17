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

  // --- Resource budget ----------------------------------------------------
  //
  // The whole platform — website, worker and every WhatsApp socket — shares
  // one 512 MB container with a tenth of a CPU. These exist so that budget is
  // explicit and adjustable from the dashboard, rather than hidden in the code
  // as numbers chosen for a machine with 24 times the memory.
  //
  // They are also what the connection limits of a shared database pooler care
  // about: pool size is per process, and there are two processes.

  /** Postgres connections the website may hold. Short request-scoped queries. */
  WEB_DB_POOL: z.coerce.number().int().min(1).max(20).default(3),
  /** Postgres connections the worker may hold. Few, but longer-lived. */
  WORKER_DB_POOL: z.coerce.number().int().min(1).max(20).default(3),

  /**
   * Largest spreadsheet accepted, in megabytes.
   *
   * Parsing is not streamed — the workbook is held in memory — so this is a
   * memory limit wearing a file-size label. 4 MB of XLSX expands to roughly
   * ten times that once parsed, which is survivable in a 512 MB container
   * shared with everything else; 10 MB was not.
   */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(25).default(4),

  /** Rows accepted from one spreadsheet, whatever the file size says. */
  MAX_IMPORT_ROWS: z.coerce.number().int().min(100).max(50_000).default(5_000),

  /**
   * Spreadsheets parsed at once, across all users.
   *
   * One at a time by default. Two concurrent imports on this container is the
   * most likely way to exhaust its memory, and an import that waits a few
   * seconds is better than an instance the host kills for going over.
   */
  MAX_CONCURRENT_IMPORTS: z.coerce.number().int().min(1).max(4).default(1),
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

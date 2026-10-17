import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Start with the current environment, set the build output dir, and skip .env loading.
const env = { ...process.env, NEXT_BUILD_DIR: process.env.NEXT_BUILD_DIR ?? '.next-verify', WA_SKIP_ENV_FILE: '1' };

// Strip real secrets so they never reach the build cache or output.
for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'AUTH_SECRET', 'CREDS_ENCRYPTION_KEY', 'AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET']) delete env[key];

// loadEnv() runs Zod validation at module-import time inside next.config.ts and
// server modules. Without these stubs the schema throws, Next.js swallows the
// error, and the build hangs silently. These values satisfy the schema but are
// not real secrets — they are never embedded in the output or used at runtime.
env.DATABASE_URL            ??= 'postgres://verify:verify@localhost:5432/verify';
env.AUTH_SECRET             ??= 'verify-build-placeholder-secret-32b!!';
env.CREDS_ENCRYPTION_KEY    ??= Buffer.alloc(32).toString('base64');
env.AUTH_GOOGLE_ID          ??= 'verify-build-placeholder.apps.googleusercontent.com';
env.AUTH_GOOGLE_SECRET      ??= 'verify-build-placeholder-secret';

const result = spawnSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build'], {
  stdio: 'inherit', env,
});
process.exit(result.status ?? 1);

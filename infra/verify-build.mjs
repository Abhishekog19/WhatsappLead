import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const env = { ...process.env, NEXT_BUILD_DIR: process.env.NEXT_BUILD_DIR ?? '.next-verify', WA_SKIP_ENV_FILE: '1' };
for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'AUTH_SECRET', 'CREDS_ENCRYPTION_KEY', 'AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET']) delete env[key];
const result = spawnSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build'], {
  stdio: 'inherit', env,
});
process.exit(result.status ?? 1);

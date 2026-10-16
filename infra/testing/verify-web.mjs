import { spawn } from 'node:child_process';
import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const output = process.env.NEXT_BUILD_DIR ?? '.next-verify';
const standalone = resolve('apps/web', output, 'standalone/apps/web');
cpSync(resolve('apps/web', output, 'static'), resolve(standalone, output, 'static'), { recursive: true });
const child = spawn(process.execPath, [resolve(standalone, 'server.js')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env, WA_SKIP_ENV_FILE: '1', NODE_ENV: 'production',
    PORT: '34996', HOSTNAME: '0.0.0.0',
    DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:1/synthetic',
    AUTH_SECRET: 'synthetic-verification-secret-only',
    CREDS_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    AUTH_GOOGLE_ID: 'synthetic', AUTH_GOOGLE_SECRET: 'synthetic',
    APP_URL: 'http://localhost:34996', AUTH_URL: 'http://localhost:34996',
  },
});
// Drain output without exposing connection errors or configuration.
child.stdout.resume(); child.stderr.resume();
const base = 'http://localhost:34996';
try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { ready = (await fetch(base + '/api/ping')).ok; } catch {}
    if (ready) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert(ready, 'standalone starts');
  assert.equal(await (await fetch(base + '/api/ping')).text(), 'ok');
  const signin = await fetch(base + '/signin');
  assert.equal(signin.status, 200);
  const html = await signin.text();
  const css = html.match(/\/_next\/static\/[^" ]+\.css/);
  assert(css, 'stylesheet is linked');
  assert.equal((await fetch(base + css[0])).status, 200);
  const started = Date.now();
  assert.equal((await fetch(base + '/api/health')).status, 503);
  assert(Date.now() - started < 6000, 'readiness fails within deadline');
  console.log('Standalone boot, ping without DB, sign-in page, CSS and bounded degraded readiness passed on port 34996.');
} finally {
  child.kill('SIGTERM');
  await new Promise(r => { child.once('exit', r); setTimeout(() => { child.kill('SIGKILL'); r(); }, 3000).unref(); });
}

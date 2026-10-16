#!/usr/bin/env node
/**
 * Supervisor behaviour.
 *
 * Run with: node infra/testing/verify-launch.mjs
 *
 * The supervisor's whole job is what happens when things go wrong, so that is
 * what this exercises: a child dying must take the service down, and SIGTERM
 * must reach both children rather than being swallowed.
 *
 * Both children are replaced with stubs. Running the real website and worker
 * here would need a database and a WhatsApp connection, and would test those
 * rather than the supervision.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Sandboxes live inside the repository, not in the system temp directory.
 *
 * The supervisor starts the worker with `node --import tsx`, and tsx is
 * resolved by walking up from the working directory — which only reaches the
 * repository's node_modules if the sandbox is underneath it.
 */
const SANDBOX_ROOT = join(ROOT, '.verify', 'launch');

let passed = 0;
let skipped = 0;
const failures = [];

/**
 * Windows has no signals.
 *
 * `subprocess.kill('SIGTERM')` there calls TerminateProcess: the child is
 * destroyed outright and never runs a handler. So graceful-shutdown
 * behaviour cannot be observed on this platform — not because it is broken,
 * but because the operating system does not offer the thing being tested.
 * The container runs Linux, where it is real.
 *
 * Those assertions are reported as skipped rather than passed. A test that
 * cannot fail is worse than no test: it reads like evidence.
 */
const SIGNALS_ARE_REAL = process.platform !== 'win32';

function skip(name, why) {
  skipped += 1;
  console.log(`  skip ${name} — ${why}`);
}

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(
      `  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    );
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * A sandbox whose `apps/web/server.js` and worker entrypoint are stubs.
 *
 * The supervisor is copied in unchanged — the point is to test the real file,
 * not a reimplementation of it.
 */
function sandbox({ webBody, workerBody }) {
  const dir = join(SANDBOX_ROOT, randomUUID().slice(0, 8));

  const write = (rel, body) => {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };

  write('apps/web/server.js', webBody);
  write('apps/worker/src/index.ts', workerBody);
  // The real supervisor, copied verbatim. Testing a reimplementation of it
  // would prove nothing about the file that actually ships.
  write('infra/launch.mjs', readFileSync(join(ROOT, 'infra', 'launch.mjs'), 'utf8'));
  return dir;
}

/** A child that stays up and announces itself. */
const ALIVE = (name) => `
  console.log('${name} up');
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => { console.log('${name} got SIGTERM'); process.exit(0); });
`;

/** A child that dies on its own after a moment. */
const DIES = (name, code) => `
  console.log('${name} up');
  setTimeout(() => { console.log('${name} exiting'); process.exit(${code}); }, 600);
  process.on('SIGTERM', () => { console.log('${name} got SIGTERM'); process.exit(0); });
`;

/** A child that ignores SIGTERM, to prove the grace period is bounded. */
const STUBBORN = (name) => `
  console.log('${name} up');
  process.on('SIGTERM', () => { console.log('${name} ignoring SIGTERM'); });
  setInterval(() => {}, 1000);
`;

function run(dir, env = {}) {
  const child = spawn(process.execPath, ['infra/launch.mjs'], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: '34567',
      WORKER_HEALTH_PORT: '34568',
      // tsx is not installed in the sandbox, and the worker stub is plain JS.
      NODE_OPTIONS: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));

  return {
    child,
    get output() {
      return output;
    },
    exited: new Promise((resolve) =>
      child.on('exit', (code, signal) => resolve({ code, signal })),
    ),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dirs = [];

  try {
    // -----------------------------------------------------------------------
    section('Both children are started');

    const dirA = sandbox({ webBody: ALIVE('web'), workerBody: ALIVE('worker') });
    dirs.push(dirA);
    const a = run(dirA);
    await sleep(1_500);

    check('the website is started', /web up/.test(a.output), a.output.slice(0, 200));
    check('the worker is started', /worker up/.test(a.output));
    check(
      'the public port is passed through to the website',
      /"port":"34567"/.test(a.output),
      a.output.match(/\{[^}]*port[^}]*\}/)?.[0],
    );

    // -----------------------------------------------------------------------
    section('SIGTERM reaches both children');

    a.child.kill('SIGTERM');
    const resultA = await a.exited;

    if (SIGNALS_ARE_REAL) {
      check('the website is asked to stop', /web got SIGTERM/.test(a.output));
      check('the worker is asked to stop', /worker got SIGTERM/.test(a.output));
      check('a clean stop exits zero', resultA.code === 0, resultA);
    } else {
      skip('SIGTERM reaches both children', 'Windows kills processes outright');
      skip('a clean stop exits zero', 'Windows kills processes outright');
      check(
        'the supervisor still terminates when signalled',
        resultA.code !== null || resultA.signal !== null,
        resultA,
      );
    }

    // -----------------------------------------------------------------------
    section('A dead worker takes the service down');

    // The case that matters most: without this the website keeps answering
    // health checks while nothing is being sent, and campaigns stall silently.
    const dirB = sandbox({ webBody: ALIVE('web'), workerBody: DIES('worker', 1) });
    dirs.push(dirB);
    const b = run(dirB);
    const resultB = await Promise.race([
      b.exited,
      sleep(12_000).then(() => ({ code: 'timeout' })),
    ]);

    check('the service exits when the worker dies', resultB.code !== 'timeout', resultB);
    check('and exits nonzero, so the host restarts it', resultB.code === 1, resultB);
    if (SIGNALS_ARE_REAL) {
      check('stopping the website on the way out', /web got SIGTERM/.test(b.output));
    } else {
      skip('stopping the website on the way out', 'no signal delivery on Windows');
    }

    // -----------------------------------------------------------------------
    section('A dead website also takes the service down');

    const dirC = sandbox({ webBody: DIES('web', 3), workerBody: ALIVE('worker') });
    dirs.push(dirC);
    const c = run(dirC);
    const resultC = await Promise.race([
      c.exited,
      sleep(12_000).then(() => ({ code: 'timeout' })),
    ]);

    check('the service exits when the website dies', resultC.code !== 'timeout', resultC);
    check("and carries the child's exit code", resultC.code === 3, resultC);
    if (SIGNALS_ARE_REAL) {
      check('stopping the worker on the way out', /worker got SIGTERM/.test(c.output));
    } else {
      skip('stopping the worker on the way out', 'no signal delivery on Windows');
    }

    // -----------------------------------------------------------------------
    section('A clean exit is still a failure');

    // Neither half is supposed to exit on its own. Exiting zero means the
    // service is now half dead, which is not success.
    const dirD = sandbox({ webBody: ALIVE('web'), workerBody: DIES('worker', 0) });
    dirs.push(dirD);
    const d = run(dirD);
    const resultD = await Promise.race([
      d.exited,
      sleep(12_000).then(() => ({ code: 'timeout' })),
    ]);
    check(
      'a child exiting zero unexpectedly still fails the service',
      resultD.code === 1,
      resultD,
    );

    // -----------------------------------------------------------------------
    section('Shutdown is bounded');

    const dirE = sandbox({ webBody: STUBBORN('web'), workerBody: ALIVE('worker') });
    dirs.push(dirE);
    const e = run(dirE, { SHUTDOWN_GRACE_MS: '1500' });
    await sleep(1_200);
    const startedAt = Date.now();
    e.child.kill('SIGTERM');
    const resultE = await Promise.race([
      e.exited,
      sleep(15_000).then(() => ({ code: 'timeout' })),
    ]);
    const took = Date.now() - startedAt;

    if (SIGNALS_ARE_REAL) {
      check(
        'a child that ignores SIGTERM does not hang the shutdown',
        resultE.code !== 'timeout',
        resultE,
      );
      check('it is killed once the grace period lapses', took < 10_000, { took });
      check(
        'and the grace period is actually waited out first',
        /ignoring SIGTERM/.test(e.output),
      );
    } else {
      // A child cannot ignore termination here, so the grace period is never
      // exercised. Claiming otherwise would be claiming a pass for nothing.
      skip('bounded shutdown of an unresponsive child', 'cannot ignore SIGTERM on Windows');
      check('the supervisor still exits promptly', took < 10_000, { took });
    }

    // -----------------------------------------------------------------------
    section('Port collision is refused rather than half-started');

    const dirF = sandbox({ webBody: ALIVE('web'), workerBody: ALIVE('worker') });
    dirs.push(dirF);
    const f = run(dirF, { PORT: '34570', WORKER_HEALTH_PORT: '34570' });
    const resultF = await Promise.race([
      f.exited,
      sleep(8_000).then(() => ({ code: 'timeout' })),
    ]);
    check(
      'the worker health port cannot collide with the public port',
      resultF.code === 1,
      resultF,
    );
    check('and it says so', /collides/.test(f.output), f.output.slice(0, 200));
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }

  console.log(
    `\n${passed} passed, ${failures.length} failed, ${skipped} skipped${failures.length ? `: ${failures.join(', ')}` : ''}`,
  );
  if (skipped > 0) {
    console.log(
      'Skipped checks need real signals. They run on Linux, which is what the ' +
        'container uses; Windows terminates child processes unconditionally.',
    );
  }
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error('\nVerification crashed:', error);
  process.exit(1);
});

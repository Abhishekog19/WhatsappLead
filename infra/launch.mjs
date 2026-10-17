#!/usr/bin/env node
/**
 * Runs the website and the WhatsApp worker as one service.
 *
 * Normally these are two deployments. Here they share a single free instance,
 * to fit the initial deployment budget; the worker cannot be
 * serverless — it holds a WhatsApp socket open for hours.
 *
 * Node rather than a shell script. `cmd_a & cmd_b & wait` looks equivalent and
 * is not: the shell does not forward signals to background jobs, so a
 * container stop would kill the shell and leave the children to be SIGKILLed
 * seconds later — mid-send, with a claimed row and no record of what happened.
 * It also cannot notice one child dying, which is the case that matters most.
 *
 * THE RULE THIS ENFORCES: the service is healthy only if BOTH halves are
 * running. If the worker dies, the website stays up and keeps answering health
 * checks while nothing is being sent — campaigns silently stall and the
 * platform looks fine. So either child exiting takes the whole service down,
 * and the host restarts it.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

/** How long a child gets to exit cleanly before it is killed outright. */
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);

/**
 * The worker's health endpoint, which is internal.
 *
 * Only the website is published; this is for the readiness check to ask the
 * worker whether it is actually working. Kept clear of the public port and of
 * the ports the host reserves (18012, 18013, 19099).
 */
const WORKER_HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 3_001);

const PORT = process.env.PORT ?? '10000';

if (String(WORKER_HEALTH_PORT) === String(PORT)) {
  console.error(
    `[launch] WORKER_HEALTH_PORT (${WORKER_HEALTH_PORT}) collides with the ` +
      `public PORT (${PORT}). Set WORKER_HEALTH_PORT to something else.`,
  );
  process.exit(1);
}

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const children = new Map();
let shuttingDown = false;
let exitCode = 0;

function log(message, extra) {
  const line = { t: new Date().toISOString(), service: 'launch', msg: message, ...extra };
  console.log(JSON.stringify(line));
}

/**
 * @param {string} name
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function start(name, args, env) {
  // stdio inherited so both children log straight to the platform's collector;
  // piping would mean re-emitting every line and losing ordering.
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });

  children.set(name, child);
  log('started', { child: name, pid: child.pid });

  child.on('exit', (code, signal) => {
    children.delete(name);

    if (shuttingDown) {
      log('child exited during shutdown', { child: name, code, signal });
      return;
    }

    // Neither child is supposed to exit on its own — not even cleanly. A zero
    // exit here still means the service is now half-dead, so it is a failure.
    log('child exited unexpectedly, stopping the service', {
      child: name,
      code,
      signal,
    });
    exitCode = code && code !== 0 ? code : 1;
    void shutdown(`${name} exited`);
  });

  child.on('error', (error) => {
    log('child could not be started', { child: name, error: String(error) });
    exitCode = 1;
    void shutdown(`${name} failed to start`);
  });

  return child;
}

/**
 * Stops both children, then exits.
 *
 * SIGTERM first so the worker can finish the message in flight, release its
 * session leases and close its sockets — leases especially, because a
 * replacement instance is usually already starting and would otherwise wait
 * for them to lapse.
 */
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down', { reason, children: [...children.keys()] });

  for (const [name, child] of children) {
    try {
      child.kill('SIGTERM');
    } catch (error) {
      log('could not signal child', { child: name, error: String(error) });
    }
  }

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (children.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Anything still alive has had its chance.
  for (const [name, child] of children) {
    log('child did not exit in time, killing', { child: name });
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone between the check and the signal.
    }
  }

  // Reap direct children after SIGKILL before the supervisor exits.
  const reapDeadline = Date.now() + 2_000;
  while (children.size && Date.now() < reapDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  log('shutdown complete', { exitCode });
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------

log('starting', { port: PORT, workerHealthPort: WORKER_HEALTH_PORT });

// The website. Next's standalone output; HOSTNAME is set explicitly because
// binding to localhost would make the service unreachable from outside the
// container, which presents as a health check that never passes.
start('web', ['apps/web/server.js'], {
  PORT: String(PORT),
  HOSTNAME: '0.0.0.0',
  WORKER_HEALTH_HOST: '127.0.0.1',
  NODE_ENV: 'production',
});

// The worker. Still run through tsx: the workspace packages ship TypeScript
// source rather than build output, and transpiling at startup costs a few
// hundred milliseconds once in a process that then runs for hours.
start(
  'worker',
  ['--import', 'tsx', 'apps/worker/src/index.ts'],
  {
    WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT),
    WORKER_HEALTH_HOST: '127.0.0.1',
    NODE_ENV: 'production',
  },
);

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// A supervisor that crashes takes its children with it as orphans. Log loudly
// and shut down deliberately instead.
process.on('uncaughtException', (error) => {
  log('supervisor crashed', { error: String(error) });
  exitCode = 1;
  void shutdown('uncaught exception');
});
process.on('unhandledRejection', (reason) => {
  log('unhandled rejection in supervisor', { error: String(reason) });
  exitCode = 1;
  void shutdown('unhandled rejection');
});

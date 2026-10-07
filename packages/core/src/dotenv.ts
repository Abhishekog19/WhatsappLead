import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Loads the repository-root `.env` into process.env, for local development.
 *
 * Only the containers get their environment handed to them: Compose passes
 * the root `.env` through `env_file`, and `.dockerignore` keeps that file out
 * of the images entirely. Running a process straight from a terminal skips
 * all of that, so entrypoints call this first.
 *
 * Two properties worth relying on:
 *
 *   - Real environment variables win. Node's loader does not overwrite a key
 *     that is already set, so an exported `DATABASE_URL` still beats the file
 *     and a stray `.env` could never shadow what Compose provides.
 *   - A missing file is not an error. In production there is nothing to load
 *     and that is the expected case, so this stays silent rather than warning
 *     about a file that should not exist there.
 *
 * The search walks upward because the caller's working directory depends on
 * how it was started — npm sets it to the workspace package, an operator
 * running `tsx` by hand may be anywhere in the tree.
 */
export function loadEnvFile(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);

  // Bounded by reaching the filesystem root, where dirname() stops changing.
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

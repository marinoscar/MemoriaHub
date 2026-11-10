import { createCli, EXIT, exitCodeFor, formatError } from '@marinoscar/platform-cli';
import { Command } from 'commander';

import { APP_CLI_OPTIONS } from './app.js';
import {
  applyEnvCompat,
  mergeAfterPlatformLogin,
  platformConfigDir,
  migrateLegacyConfig,
  snapshotAppFields,
} from './extensions/config-compat.js';
import { translateLegacyArgs } from './extensions/legacy-flags.js';
import { applyLegacyWorkerEnv } from './worker-env.js';
import { legacyDaemonNotice } from './extensions/legacy-daemon-notice.js';

// =============================================================================
// One invocation of the CLI  (issue #577, RETRO-F3)
// =============================================================================
//
// `cli.ts` is the import-light entry point; the work of one invocation lives
// here so it can be tested without a process exiting under the test runner.
// Around `createCli(...).run` it does:
//
//   1. environment and config compatibility (MEMORIAHUB_URL, pat -> token),
//   2. `translateLegacyArgs` (extensions/legacy-flags.ts),
//   3. the worker's 1.3 environment names and a leftover 1.3 daemon (RETRO-C10),
//   4. after `login`, restores the app's fields the platform's login replaced,
//
// It returns the exit code and never calls `process.exit()` itself.
// =============================================================================

/**
 * `formatError`, which needs the CLI identity set while building the CLI; a
 * build that failed earlier must still print its reason.
 */
export function describeError(error: unknown): string {
  try {
    return formatError(error);
  } catch {
    return error instanceof Error ? `memoriahub: ${error.message}` : `memoriahub: ${String(error)}`;
  }
}

/** Where one invocation writes and which seams it uses; defaults are the process's. */
export interface RunAppOptions {
  stderr?: { write(text: string): unknown } | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Builds the CLI; tests substitute a fake. */
  createCli?: typeof createCli | undefined;
}

/**
 * Runs the CLI once.
 *
 * @param argv - The arguments after the executable name.
 * @param options - Streams and seams; omit all of them to run for real.
 * @returns the exit code.
 */
export async function runApp(argv: string[], options: RunAppOptions = {}): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;

  // 1. Environment and stored-config compatibility. Never fatal: a worker
  //    container with a read-only home runs on its environment alone.
  Object.assign(env, applyEnvCompat(env));
  migrateLegacyConfig();

  // 2. Legacy spellings.
  const plan = translateLegacyArgs(argv, { env });
  Object.assign(env, plan.env);
  for (const note of plan.notes) stderr.write(`${note}\n`);
  if (plan.refuse !== undefined) {
    stderr.write(`${plan.refuse}\n`);
    return EXIT.USAGE;
  }

  // 3. The worker's 1.3 variable names and a 1.3 daemon still running (RETRO-C10).
  for (const note of applyLegacyWorkerEnv(env)) stderr.write(`memoriahub: ${note}\n`);
  if (plan.argv[0] === 'node') {
    const notice = legacyDaemonNotice();
    if (notice !== undefined) stderr.write(`${notice}\n`);
  }

  let cli: ReturnType<typeof createCli>;
  try {
    cli = (options.createCli ?? createCli)(APP_CLI_OPTIONS);
  } catch (error) {
    stderr.write(`${describeError(error)}\n`);
    return exitCodeFor(error);
  }

  // 4. The platform `login` rewrites config.json with only its own fields.
  const isLogin = plan.argv[0] === 'login';
  const appFields = isLogin ? snapshotAppFields() : {};

  const code = await cli.run(plan.argv);

  if (isLogin && code === EXIT.OK) mergeAfterPlatformLogin(appFields, platformConfigDir(env));

  return code;
}

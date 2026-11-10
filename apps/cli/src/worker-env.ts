/**
 * worker-env.ts - the worker's environment variables (RETRO-C10, #616).
 *
 * The one file that spells `MEMORIAHUB_*` names for the worker (the platform's `env-prefix` rule).
 * The platform declares the canonical worker variables (`MEMORIAHUB_CONCURRENCY`, `_HEAP_LIMIT_MB`,
 * ...); this file adds the app's own and the legacy spellings of the 1.3 worker, which keep working
 * for one release with a deprecation line.
 *
 *   1.3 name                          platform / app name                 how
 *   MEMORIAHUB_MAX_OLD_SPACE_MB       MEMORIAHUB_HEAP_LIMIT_MB            platform alias
 *   MEMORIAHUB_HEAP_SNAPSHOT          MEMORIAHUB_HEAP_SNAPSHOTS           platform alias
 *   MEMORIAHUB_MEMWATCH               MEMORIAHUB_MEMORY_WATCHDOG          platform alias
 *   MEMORIAHUB_HEAP_RESTART_FRACTION  MEMORIAHUB_MEMORY_THRESHOLD         platform alias (fraction in both)
 *   MEMORIAHUB_SHARP_CONCURRENCY      MEMORIAHUB_NATIVE_THREADS           mirrored by applyLegacyWorkerEnv
 *   MODELS_DIR / ~/.memoriahub/models MEMORIAHUB_MODELS_DIR               mirrored by applyLegacyWorkerEnv
 *   MEMORIAHUB_STARTUP_SELFTEST       (none)                              dropped: the platform self-tests in headless mode
 *   MEMORIAHUB_URL                    MEMORIAHUB_SERVER_URL               extensions/config-compat.ts
 *   unchanged: _TOKEN _NODE_ID _NODE_NAME _CONCURRENCY _ELIGIBLE_TYPES _POLL_INTERVAL_MS _HEADLESS
 *              _STATE_DIR _HEAP_TUNED _FACE_PROVIDER _COMPREFACE_URL _CLIP_RECYCLE_AFTER
 *
 * `MEMORIAHUB_STATE_DIR` changed meaning on the platform: it is the node's state directory (pidfile,
 * socket, logs, models), no longer also the location of `config.json`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { WorkerEnvKey } from '@marinoscar/platform-cli/node';

/** The app's own worker variables. */
export const appWorkerEnv = {
  /** Base URL of the compreface-core sidecar. */
  comprefaceUrl: 'MEMORIAHUB_COMPREFACE_URL',
  /** The face provider; CompreFace is the only accepted value. */
  faceProvider: 'MEMORIAHUB_FACE_PROVIDER',
  /** Embeds before the CLIP session is recycled; 0 disables. */
  clipRecycleAfter: 'MEMORIAHUB_CLIP_RECYCLE_AFTER',
  /** Models directory (the platform reads it too). */
  modelsDir: 'MEMORIAHUB_MODELS_DIR',
  /** Native thread cap (the platform reads it). */
  nativeThreads: 'MEMORIAHUB_NATIVE_THREADS',
  /** Legacy: libvips concurrency. */
  legacySharpConcurrency: 'MEMORIAHUB_SHARP_CONCURRENCY',
  /** Legacy: startup self-test switch. */
  legacyStartupSelftest: 'MEMORIAHUB_STARTUP_SELFTEST',
} as const;

/** Legacy names per platform worker key, for `createCli({ node: { envAliases } })`. */
export const WORKER_ENV_ALIASES: Partial<Record<WorkerEnvKey, readonly string[]>> = {
  heapLimitMb: ['MEMORIAHUB_MAX_OLD_SPACE_MB'],
  heapSnapshots: ['MEMORIAHUB_HEAP_SNAPSHOT'],
  memoryWatchdog: ['MEMORIAHUB_MEMWATCH'],
  memoryThreshold: ['MEMORIAHUB_HEAP_RESTART_FRACTION'],
};

/** The exit code of the memory valve, as the 1.3 worker (a supervisor restarts it). */
export const MEMORY_VALVE_EXIT_CODE = 75;

/**
 * Mirrors the 1.3 names the platform has no alias for onto the current ones. Returns the lines to
 * print once (deprecation). Never overrides a value that is set.
 */
export function applyLegacyWorkerEnv(
  env: NodeJS.ProcessEnv,
  home: string = os.homedir(),
): string[] {
  const notes: string[] = [];
  const unset = (name: string): boolean => (env[name] ?? '').trim() === '';

  const sharp = env[appWorkerEnv.legacySharpConcurrency];
  if (unset(appWorkerEnv.nativeThreads) && sharp !== undefined && sharp.trim() !== '') {
    env[appWorkerEnv.nativeThreads] = sharp.trim();
    notes.push(`${appWorkerEnv.legacySharpConcurrency} is deprecated; use ${appWorkerEnv.nativeThreads}.`);
  }

  if (unset(appWorkerEnv.modelsDir)) {
    const legacy = env['MODELS_DIR']?.trim();
    if (legacy) {
      env[appWorkerEnv.modelsDir] = legacy;
    } else {
      const old = path.join(home, '.memoriahub', 'models');
      try {
        if (fs.statSync(old).isDirectory()) env[appWorkerEnv.modelsDir] = old;
      } catch {
        /* no 1.3 models directory */
      }
    }
  }

  if (!unset(appWorkerEnv.legacyStartupSelftest)) {
    notes.push(
      `${appWorkerEnv.legacyStartupSelftest} is ignored: the worker self-tests at start in headless mode.`,
    );
  }

  const face = env[appWorkerEnv.faceProvider]?.trim();
  if (face && face !== 'compreface') {
    notes.push(`${appWorkerEnv.faceProvider}=${face} is not supported; CompreFace is the only face provider.`);
  }

  if (unset(appWorkerEnv.comprefaceUrl)) env[appWorkerEnv.comprefaceUrl] = 'http://localhost:3000';
  return notes;
}

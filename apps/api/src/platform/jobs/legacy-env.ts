// =============================================================================
// ENRICHMENT_* -> JOBS_* environment translation (RETRO-C1, #575)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(RETRO-C11): for ONE release the variables that tuned
// the old queue (`ENRICHMENT_*`) still work. `legacyJobsEnv` returns a COPY of
// the environment in which every `JOBS_*` variable the platform reads is filled
// from its legacy name when it is unset (a `JOBS_*` value always wins), and
// logs one deprecation warning per legacy variable that is set. The result feeds
// `jobsConfiguration()` (config/configuration.ts); `process.env` is not mutated.
//
//   ENRICHMENT_WORKER_MODE (ENRICHMENT_WORKER_ENABLED=false, FACE_WORKER_ENABLED=false -> off)
//                                       -> JOBS_WORKER_MODE
//   ENRICHMENT_WORKER_CONCURRENCY (FACE_WORKER_CONCURRENCY) -> JOBS_WORKER_CONCURRENCY
//   ENRICHMENT_JOB_POLL_MS (FACE_JOB_POLL_MS)               -> JOBS_POLL_MS
//   ENRICHMENT_JOB_TIMEOUT_MS                               -> JOBS_JOB_TIMEOUT_MS
//   ENRICHMENT_MAX_ATTEMPTS / _RETRY_BASE_MS / _RETRY_MAX_MS -> JOBS_MAX_ATTEMPTS / ...
//   ENRICHMENT_RATELIMIT_BASE_MS / _MAX_MS / _MAX_HITS      -> JOBS_RATELIMIT_...
//   ENRICHMENT_REAPER_ENABLED                               -> JOBS_REAPER_ENABLED
//   ENRICHMENT_SYSTEM_MODE_EXTRA_TYPES                      -> JOBS_SYSTEM_MODE_EXTRA_TYPES
//   ENRICHMENT_VIDEO_JOB_TIMEOUT_MS                         -> profile.maxRuntimeMs of the three video types
//                                                              (`videoJobTimeoutMs`, below)
//   ENRICHMENT_LEASE_MS, ENRICHMENT_STUCK_MINUTES           -> removed: the lease and the reaper's patience
//                                                              derive from `profile.maxRuntimeMs`
//
// TWO DEFAULTS THAT STAY THE OLD QUEUE'S, because a deployment that never set a
// variable must not change behaviour:
//   * JOBS_WORKER_CONCURRENCY is 1 (the platform default is 2). Every concurrent
//     job buffers a decoded image; the bulk-import tuning guide says to raise it
//     deliberately.
//   * JOBS_SYSTEM_MODE_EXTRA_TYPES always carries `thumbnail_repair` and
//     `workflow_execute_batch`: both are node-eligible handlers that the
//     `system` worker mode has always claimed on the server too (a global sweep;
//     a DB-bound batch that must run with no fleet). Operator extras are added.
// =============================================================================

import { Logger } from '@nestjs/common';

/** Node-eligible types the `system` worker mode has always run on the server. */
export const SYSTEM_MODE_PINNED_TYPES: readonly string[] = ['thumbnail_repair', 'workflow_execute_batch'];

/** The old queue's default concurrency (the platform's is 2). */
export const LEGACY_DEFAULT_WORKER_CONCURRENCY = '1';

/** The old video-bucket timeout: 20 minutes. */
export const LEGACY_VIDEO_JOB_TIMEOUT_MS = 1_200_000;

/** `[legacy names in precedence order, the JOBS_* name]`. */
const DIRECT_MAP: ReadonlyArray<readonly [readonly string[], string]> = [
  [['ENRICHMENT_WORKER_MODE'], 'JOBS_WORKER_MODE'],
  [['ENRICHMENT_WORKER_CONCURRENCY', 'FACE_WORKER_CONCURRENCY'], 'JOBS_WORKER_CONCURRENCY'],
  [['ENRICHMENT_JOB_POLL_MS', 'FACE_JOB_POLL_MS'], 'JOBS_POLL_MS'],
  [['ENRICHMENT_JOB_TIMEOUT_MS'], 'JOBS_JOB_TIMEOUT_MS'],
  [['ENRICHMENT_MAX_ATTEMPTS'], 'JOBS_MAX_ATTEMPTS'],
  [['ENRICHMENT_RETRY_BASE_MS'], 'JOBS_RETRY_BASE_MS'],
  [['ENRICHMENT_RETRY_MAX_MS'], 'JOBS_RETRY_MAX_MS'],
  [['ENRICHMENT_RATELIMIT_MAX_HITS'], 'JOBS_RATELIMIT_MAX_HITS'],
  [['ENRICHMENT_RATELIMIT_BASE_MS'], 'JOBS_RATELIMIT_BASE_MS'],
  [['ENRICHMENT_RATELIMIT_MAX_MS'], 'JOBS_RATELIMIT_MAX_MS'],
  [['ENRICHMENT_REAPER_ENABLED'], 'JOBS_REAPER_ENABLED'],
];

/** Variables with no replacement: set → warn, then ignore. */
const REMOVED = ['ENRICHMENT_LEASE_MS', 'ENRICHMENT_STUCK_MINUTES'] as const;

const logger = new Logger('LegacyJobsEnv');
const warned = new Set<string>();

/** Test hook: forget which variables were already reported. */
export function resetLegacyEnvWarnings(): void {
  warned.clear();
}

function warnOnce(name: string, message: string, sink: (m: string) => void): void {
  if (warned.has(name)) return;
  warned.add(name);
  sink(message);
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/**
 * The environment the platform's `jobsConfiguration()` should read: `env` plus
 * every `JOBS_*` variable the legacy names supply.
 *
 * @param env - the process environment (a copy is returned).
 * @param warn - where the deprecation warnings go; the Nest logger by default.
 */
export function legacyJobsEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => logger.warn(message),
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };

  for (const [legacyNames, target] of DIRECT_MAP) {
    for (const legacy of legacyNames) {
      if (!isSet(env[legacy])) continue;
      if (isSet(env[target])) {
        warnOnce(legacy, `${legacy} is deprecated and ignored: ${target} is set and wins. Remove ${legacy}.`, warn);
      } else {
        warnOnce(legacy, `${legacy} is deprecated; read as ${target} for this release. Rename it to ${target}.`, warn);
        if (!isSet(out[target])) out[target] = env[legacy];
      }
    }
  }

  // The on/off switches that predate ENRICHMENT_WORKER_MODE.
  if (!isSet(out['JOBS_WORKER_MODE'])) {
    for (const legacy of ['ENRICHMENT_WORKER_ENABLED', 'FACE_WORKER_ENABLED']) {
      if (env[legacy] === 'false') {
        warnOnce(legacy, `${legacy}=false is deprecated; read as JOBS_WORKER_MODE=off for this release.`, warn);
        out['JOBS_WORKER_MODE'] = 'off';
      }
    }
  }

  if (!isSet(out['JOBS_WORKER_CONCURRENCY'])) out['JOBS_WORKER_CONCURRENCY'] = LEGACY_DEFAULT_WORKER_CONCURRENCY;

  // The extra system-mode types: the always-pinned two plus whatever the operator named.
  const extras = new Set<string>(SYSTEM_MODE_PINNED_TYPES);
  const named = env['JOBS_SYSTEM_MODE_EXTRA_TYPES'] ?? env['ENRICHMENT_SYSTEM_MODE_EXTRA_TYPES'] ?? '';
  if (!isSet(env['JOBS_SYSTEM_MODE_EXTRA_TYPES']) && isSet(env['ENRICHMENT_SYSTEM_MODE_EXTRA_TYPES'])) {
    warnOnce(
      'ENRICHMENT_SYSTEM_MODE_EXTRA_TYPES',
      'ENRICHMENT_SYSTEM_MODE_EXTRA_TYPES is deprecated; read as JOBS_SYSTEM_MODE_EXTRA_TYPES for this release.',
      warn,
    );
  }
  for (const type of named.split(',').map((t) => t.trim()).filter(Boolean)) extras.add(type);
  out['JOBS_SYSTEM_MODE_EXTRA_TYPES'] = [...extras].join(',');

  if (isSet(env['ENRICHMENT_VIDEO_JOB_TIMEOUT_MS'])) {
    warnOnce(
      'ENRICHMENT_VIDEO_JOB_TIMEOUT_MS',
      'ENRICHMENT_VIDEO_JOB_TIMEOUT_MS is deprecated; it still sets the 20-minute execution profile of ' +
        'video_face_detection, social_media_detection and video_auto_tagging for this release.',
      warn,
    );
  }

  for (const name of REMOVED) {
    if (isSet(env[name])) {
      warnOnce(
        name,
        `${name} is no longer read: the lease and the stuck-job threshold derive from each job type's ` +
          'execution profile (maxRuntimeMs). Remove it.',
        warn,
      );
    }
  }

  return out;
}

/**
 * The in-process worker mode as the deployment configured it: `JOBS_WORKER_MODE`, else the legacy
 * `ENRICHMENT_WORKER_MODE`, else `off` when a legacy on/off switch says `false`, else `all`.
 * A plain read (no warning); `legacyJobsEnv` is what logs the deprecations.
 */
export function configuredWorkerMode(env: NodeJS.ProcessEnv = process.env): string {
  if (isSet(env['JOBS_WORKER_MODE'])) return env['JOBS_WORKER_MODE'];
  if (isSet(env['ENRICHMENT_WORKER_MODE'])) return env['ENRICHMENT_WORKER_MODE'];
  return env['ENRICHMENT_WORKER_ENABLED'] === 'false' || env['FACE_WORKER_ENABLED'] === 'false' ? 'off' : 'all';
}

/**
 * `maxRuntimeMs` of the three video job types: `ENRICHMENT_VIDEO_JOB_TIMEOUT_MS`
 * when it is a non-negative integer (0 = no ceiling), else 20 minutes.
 */
export function videoJobTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['ENRICHMENT_VIDEO_JOB_TIMEOUT_MS'];
  if (!isSet(raw)) return LEGACY_VIDEO_JOB_TIMEOUT_MS;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? LEGACY_VIDEO_JOB_TIMEOUT_MS : parsed;
}

/**
 * executors/define.ts - turns a compute module into a platform `JobExecutor` (RETRO-C10, #616).
 *
 * `execute` returns exactly what the compute module returns (the shape of the server handler's
 * `nodeResultSchema`) and throws to fail. A provider throttle is converted for the engine
 * (`withPlatformRateLimit`). The engine streams the input object to `inputPath` before `execute`
 * when `input` is `'download'`. The compute module is imported on first use, so a node pays for
 * the native libraries of the types it actually runs.
 *
 * A type whose ffmpeg needs only the bytes around each seek point could declare `input: 'url'` and
 * read `context.inputUrl` instead of downloading; no MemoriaHub type does today (the only one,
 * `video_auto_tagging`, is server-only), see README.md.
 */

import type { JobExecutionContext, JobExecutor, JobInputMode } from '@marinoscar/platform-cli/node';

import type { ComputeFn } from './support.js';
import { computeContextOf, requireInputPath } from './support.js';
import { withPlatformRateLimit } from './rate-limit.js';

export interface ExecutorDefinition {
  type: string;
  input: JobInputMode;
  /** Imports the compute module (`() => import('./compute/x.js')`). */
  load: () => Promise<{ default: ComputeFn }>;
  vitals?: () => Record<string, number> | undefined;
}

export function defineExecutor(definition: ExecutorDefinition): JobExecutor {
  return {
    type: definition.type,
    input: definition.input,
    async execute(context: JobExecutionContext): Promise<unknown> {
      const compute = (await definition.load()).default;
      const inputPath = definition.input === 'download' ? requireInputPath(context) : '';
      return withPlatformRateLimit(() => compute(inputPath, context.params, computeContextOf(context)));
    },
    ...(definition.vitals !== undefined ? { vitals: definition.vitals } : {}),
  };
}

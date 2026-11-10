/**
 * executors/rate-limit.ts - provider throttles as the platform engine wants them (RETRO-C10, #616).
 *
 * The compute modules throw `@memoriahub/enrichment-compute/rate-limit`'s `ProviderRateLimitError`
 * (the API's `geo` and `ai` code share it). The node engine reports `{ rateLimited, retryAfterMs }`,
 * which makes the server defer the job without consuming an attempt, only for an `instanceof` the
 * PLATFORM's own class. `withPlatformRateLimit` converts one into the other.
 *
 * PLATFORM-ADOPTION-SHIM(RETRO-SEAM-NODE-RATELIMIT): the platform does not export its class (a seam
 * request is filed). The class is loaded from the installed package's file, by URL, which is the
 * module instance the engine itself imports; if that cannot be done the conversion is skipped and
 * the throttle is an ordinary failure (the job still retries, but charges an attempt).
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ProviderRateLimitError as ComputeRateLimitError } from '@memoriahub/enrichment-compute/rate-limit';

type PlatformCtor = new (message: string, options: { retryAfterMs: number; provider?: string; cause?: unknown }) => Error;

let platformCtor: PlatformCtor | null | undefined;

async function loadPlatformCtor(): Promise<PlatformCtor | null> {
  if (platformCtor !== undefined) return platformCtor;
  try {
    const pkg = createRequire(import.meta.url).resolve('@marinoscar/platform-cli/package.json');
    const file = path.join(path.dirname(pkg), 'dist', 'engine', 'node', 'node-errors.js');
    const mod = (await import(pathToFileURL(file).href)) as { ProviderRateLimitError?: PlatformCtor };
    platformCtor = mod.ProviderRateLimitError ?? null;
  } catch {
    platformCtor = null;
  }
  return platformCtor;
}

/** Runs `work`; a compute-package throttle is rethrown as the platform's `ProviderRateLimitError`. */
export async function withPlatformRateLimit<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ComputeRateLimitError) {
      const Ctor = await loadPlatformCtor();
      if (Ctor !== null) {
        const wanted = error.retryAfterMs;
        const retryAfterMs = typeof wanted === 'number' && Number.isFinite(wanted) ? Math.max(0, wanted) : 30_000;
        throw new Ctor(error.message, {
          retryAfterMs,
          ...(typeof (error as { provider?: unknown }).provider === 'string'
            ? { provider: (error as { provider: string }).provider }
            : {}),
          cause: error,
        });
      }
    }
    throw error;
  }
}

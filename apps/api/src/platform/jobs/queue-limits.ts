import { jobsConfiguration } from '@marinoscar/platform-api/jobs';

import { legacyJobsEnv } from './legacy-env';

// =============================================================================
// The queue's retry budgets, as the legacy handlers read them (RETRO-C1, #575)
// =============================================================================
//
// `PictureEnhancementHandler` mirrors a job's state into its own row and must
// predict whether THIS failure is the one the queue will requeue or the one it
// gives up on, so it needs the same budgets the platform terminal state machine
// uses. They were exported from `enrichment-terminal.service.ts`; that file is
// gone, and the values now come from the same configuration the platform reads
// (`JOBS_MAX_ATTEMPTS`, `JOBS_RATELIMIT_MAX_HITS`, with the legacy `ENRICHMENT_*`
// names translated for one release).
//
// PLATFORM-ADOPTION-SHIM(RETRO-C3..C8): goes with the legacy handlers.
// =============================================================================

const resolved = jobsConfiguration(legacyJobsEnv()).jobs;

/** Attempts before a job fails for good. */
export const ENRICHMENT_MAX_ATTEMPTS: number = resolved.maxAttempts;

/** Provider rate-limit deferrals before a job fails for good. */
export const ENRICHMENT_RATELIMIT_MAX_HITS: number = resolved.rateLimitMaxHits;

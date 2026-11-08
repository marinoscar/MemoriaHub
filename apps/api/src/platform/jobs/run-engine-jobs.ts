import type { Job, RetentionPolicyDefinition } from '@marinoscar/platform-api/jobs';

// =============================================================================
// Shared helpers for the run-engine job handlers (RETRO-C7, #604)
// =============================================================================
//
// MemoriaHub's three "run engines" (Media Workflow Automation, the shared review
// runs of bursts / duplicates / location suggestions, and Empty Trash at scale)
// drive a run row through the queue with an evaluate job, then a fan-out of
// execute-batch jobs. Every one of those jobs names its run in `payload.runId`;
// the circle is the job's subject (`subjectType: 'circle'`), which the handlers
// never need because the run row carries it.
//
// THE INPUT SHAPE. `RunJobInput` is the three fields the handlers read. It is
// structural on purpose: the platform `Job` satisfies it, and so does the legacy
// `EnrichmentJob` the deprecated `location_suggestion_run_*` shims (RETRO-C6)
// still hand to the review-run handlers, so those shims keep delegating
// unchanged until C6 retires them.
// =============================================================================

/** What a run-engine handler reads from its job. */
export interface RunJobInput {
  /** The job id, for log lines. */
  readonly id: string;
  /** Attempts started so far (charged at claim time). */
  readonly attempts: number;
  /** The job payload: `{ runId, ... }`. */
  readonly payload: unknown;
}

/** The job payload as a plain object, or null when it is not one. */
export function runJobPayload<T extends object>(job: Pick<RunJobInput, 'payload'>): Partial<T> | null {
  const payload = job.payload;
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Partial<T>) : null;
}

/** What `vetoDeleteWhileRunActive` needs to know about one engine. */
export interface RunDeleteGuard {
  /** The engine's name in the reason ("workflow run"). */
  readonly engine: string;
  /** Run statuses that a pending job of this type still has to advance. */
  readonly activeStatuses: readonly string[];
  /** Reads the run's status, or null when the run is gone. */
  readRunStatus(runId: string): Promise<string | null>;
}

/**
 * `JobHandler.canDelete` for an evaluate or execute-batch job: refuse to delete a
 * PENDING job whose run is still active, because that job is the only thing that
 * will move the run on (deleting it strands the run in `evaluating`/`running` and,
 * through the per-circle concurrency guard, blocks every later run of the circle).
 *
 * Anything else may be deleted: a terminal job is history, a running job is
 * refused by the admin service itself, and a job whose run is gone or already
 * terminal advances nothing.
 */
export async function vetoDeleteWhileRunActive(
  job: Pick<Job, 'status' | 'payload'>,
  guard: RunDeleteGuard,
): Promise<string | null> {
  if (job.status !== 'pending') return null;
  const runId = runJobPayload<{ runId: string }>(job)?.runId;
  if (typeof runId !== 'string' || runId === '') return null;
  const status = await guard.readRunStatus(runId);
  if (status === null || !guard.activeStatuses.includes(status)) return null;
  return (
    `This job advances ${guard.engine} ${runId}, which is still ${status}: deleting it would leave ` +
    `the run stuck and block new runs of its circle. Cancel the run instead.`
  );
}

/** One `retention.*` policy as stored (the platform contract's `RetentionPolicyValue`). */
export interface RetentionPolicyValue {
  readonly enabled: boolean;
  readonly days: number;
}

/** The one settings read a retention handler needs (the app's `AppSystemSettingsService` satisfies it). */
export interface RetentionSettingsReader {
  getRetentionPolicy(): Promise<unknown>;
}

/**
 * One app-registered `retention.*` policy as stored, re-read per run (never
 * cached), or the policy's defaults when the read has no entry for it.
 *
 * The platform's typed `getRetentionPolicy()` lists its four built-in keys only;
 * an app's registered keys are in the same object, so it is read structurally.
 */
export async function readRetentionPolicy(
  settings: RetentionSettingsReader,
  policy: RetentionPolicyDefinition,
): Promise<RetentionPolicyValue> {
  const all = (await settings.getRetentionPolicy()) as Record<string, Partial<RetentionPolicyValue> | undefined>;
  const stored = all?.[policy.key];
  return {
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : (policy.defaultEnabled ?? false),
    days: typeof stored?.days === 'number' ? stored.days : policy.defaultDays,
  };
}

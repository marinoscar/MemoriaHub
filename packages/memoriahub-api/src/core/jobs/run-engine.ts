import type { MemoriahubJob } from '../../ports/index.js';

// =============================================================================
// Helpers of a run-engine job (RETRO-J5, #613)
// =============================================================================
//
// A run engine (empty trash, review runs, workflow runs) advances a run record through an evaluate job
// and chunked execute-batch jobs. These two helpers are what every engine's handlers share: reading the
// `{ runId, ... }` payload defensively, and the `canDelete` veto that stops an admin from deleting the
// pending job a live run still needs.
// =============================================================================

/**
 * What a run-engine handler reads from its job: the id for log lines, the attempts started so far
 * (charged at claim time) and the `{ runId, ... }` payload.
 *
 * @stability experimental
 */
export type MemoriahubRunJobInput = Pick<MemoriahubJob, 'id' | 'attempts' | 'payload'>;

/**
 * The job payload as a plain object, or `null` when it is not one.
 *
 * @param job - a job, or anything with a payload.
 * @stability experimental
 */
export function runJobPayload<T extends object>(job: Pick<MemoriahubJob, 'payload'>): Partial<T> | null {
  const payload = job.payload;
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Partial<T>) : null;
}

/**
 * What {@link vetoDeleteWhileRunActive} needs to know about one engine.
 *
 * @stability experimental
 */
export interface MemoriahubRunDeleteGuard {
  /** The engine's name in the reason ("workflow run"). */
  readonly engine: string;
  /** Run statuses that a pending job of this type still has to advance. */
  readonly activeStatuses: readonly string[];
  /** Reads the run's status, or `null` when the run is gone. */
  readRunStatus(runId: string): Promise<string | null>;
}

/**
 * `canDelete` for an evaluate or execute-batch job: refuse to delete a PENDING job whose run is still
 * active, because that job is the only thing that will move the run on (deleting it strands the run in
 * `evaluating`/`running` and, through the per-library concurrency guard, blocks every later run).
 * Anything else may be deleted: a terminal job is history, a running job is refused by the admin service
 * itself, and a job whose run is gone or already terminal advances nothing.
 *
 * @param job - the job the admin asked to delete.
 * @param guard - the engine's names and its run-status read.
 * @returns the reason to refuse, or `null` to allow.
 * @stability experimental
 */
export async function vetoDeleteWhileRunActive(
  job: Pick<MemoriahubJob, 'status' | 'payload'>,
  guard: MemoriahubRunDeleteGuard,
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

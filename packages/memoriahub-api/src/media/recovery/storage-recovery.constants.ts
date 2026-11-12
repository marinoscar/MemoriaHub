// =============================================================================
// Storage processing recovery: job payloads, defaults and env readers (RETRO-D1b #567, RETRO-J5 #613)
// =============================================================================
//
// Two job types, both SYSTEM jobs (`orgId: null`) and SERVER-ONLY (no node-result pair: they read and
// write storage rows across organizations through the cross-organization client):
//
//   media.storage.recover_stuck  the 10-minute recovery sweep. Mode `stuck` (the cron,
//                                `POST /api/admin/media/reprocess-stuck`) re-queues objects orphaned at
//                                `processing`; mode `failed` (`POST .../reprocess-failed`) re-queues image
//                                objects that ended `failed`.
//   media.storage.reprocess      `POST /api/admin/media/reprocess`: re-queues processing for the ready or
//                                failed media objects of one circle, or of every circle.
//
// Neither runs a processor itself: per object they queue the host's own `storage.object.process` job,
// which does the work (and marks a still-`processing` object `failed` when it gives up).
//
// THE TYPE STRINGS ARE PERMANENT once jobs of them exist (the job-type snapshot pins them); they live in
// `storage-recovery-types.ts`.
// =============================================================================

/**
 * The job type of the host's post-upload storage processing job that recovery queues per object. The
 * storage platform owns the string (permanent); the recovery payload it carries is `{ objectId, orgId }`.
 *
 * @stability experimental
 */
export const STORAGE_OBJECT_PROCESS_JOB_TYPE = 'storage.object.process';

/**
 * The subject type of that job (the object it processes); the one-live-job-per-object dedup keys on it.
 *
 * @stability experimental
 */
export const STORAGE_OBJECT_JOB_SUBJECT_TYPE = 'storage_object';

/** The queue priority of the bulk reprocess: the housekeeping priority, so an upload is always claimed first. */
export const RECOVERY_BACKGROUND_PRIORITY = 100;

/** Default minutes an object may read `processing` before the sweep treats it as orphaned. */
export const DEFAULT_STUCK_MINUTES = 10;

/** Default automatic recovery attempts per object before it is marked `failed`. */
export const DEFAULT_MAX_RETRIES = 3;

/** Rows read per keyset page of a scan. */
export const RECOVERY_SCAN_BATCH = 100;

/** `media.storage.recover_stuck` payload. A null payload (the cron's) is `{ mode: 'stuck' }`. @stability experimental */
export type StorageRecoverPayload =
  | { mode: 'stuck'; olderThanMinutes?: number }
  | { mode: 'failed'; limit?: number };

/** `media.storage.reprocess` payload. No `circleId`: every circle. @stability experimental */
export interface StorageReprocessPayload {
  /** The library to reprocess; absent means every library. */
  circleId?: string;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Reads a `media.storage.recover_stuck` payload. Anything unrecognised degrades to the cron's default
 * (`stuck`, env threshold), never to a throw: the sweep is idempotent, so running it is always safe.
 *
 * @param payload - the job payload.
 * @stability experimental
 */
export function parseRecoverPayload(payload: unknown): StorageRecoverPayload {
  const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (raw['mode'] === 'failed') {
    const limit = positiveInt(raw['limit']);
    return limit === undefined ? { mode: 'failed' } : { mode: 'failed', limit };
  }
  const olderThanMinutes = positiveInt(raw['olderThanMinutes']);
  return olderThanMinutes === undefined ? { mode: 'stuck' } : { mode: 'stuck', olderThanMinutes };
}

/**
 * Reads a `media.storage.reprocess` payload; a missing or malformed `circleId` means every circle.
 *
 * @param payload - the job payload.
 * @stability experimental
 */
export function parseReprocessPayload(payload: unknown): StorageReprocessPayload {
  const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const circleId = raw['circleId'];
  return typeof circleId === 'string' && circleId.length > 0 ? { circleId } : {};
}

/** `STORAGE_PROCESSING_STUCK_MINUTES`, else the default. @stability experimental */
export function stuckMinutesFromEnv(): number {
  const parsed = parseInt(process.env['STORAGE_PROCESSING_STUCK_MINUTES'] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STUCK_MINUTES;
}

/** `STORAGE_PROCESSING_MAX_RETRIES`, else the default. @stability experimental */
export function maxRetriesFromEnv(): number {
  const parsed = parseInt(process.env['STORAGE_PROCESSING_MAX_RETRIES'] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_RETRIES;
}

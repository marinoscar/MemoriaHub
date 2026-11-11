// =============================================================================
// Storage processing recovery: job types and payloads (RETRO-D1b, #567)
// =============================================================================
//
// Two app job types, both SYSTEM jobs (`orgId: null`) and SERVER-ONLY (no
// node-result pair: they read and write storage rows across organizations
// through the system client):
//
//   media.storage.recover_stuck  the 10-minute recovery sweep. Mode `stuck`
//                                (the cron, `POST /api/admin/media/reprocess-stuck`)
//                                re-queues objects orphaned at `processing`;
//                                mode `failed` (`POST .../reprocess-failed`)
//                                re-queues image objects that ended `failed`.
//   media.storage.reprocess      `POST /api/admin/media/reprocess`: re-queues
//                                processing for the ready/failed media objects
//                                of one circle, or of every circle.
//
// Neither runs a processor itself: per object they queue the platform's own
// `storage.object.process` job, which does the work (and marks a still-
// `processing` object `failed` when it gives up).
//
// THE TYPE STRINGS ARE PERMANENT once jobs of them exist
// (`test/jobs/job-type-snapshot.spec.ts` pins them).
// =============================================================================

// The two type strings are defined by the media slice (its admin recovery controller queues them).
export { STORAGE_RECOVER_STUCK_TYPE, STORAGE_REPROCESS_TYPE } from '@marinoscar/memoriahub-api/media';

/** Default minutes an object may read `processing` before the sweep treats it as orphaned. */
export const DEFAULT_STUCK_MINUTES = 10;

/** Default automatic recovery attempts per object before it is marked `failed`. */
export const DEFAULT_MAX_RETRIES = 3;

/** Rows read per keyset page of a scan. */
export const RECOVERY_SCAN_BATCH = 100;

/** `media.storage.recover_stuck` payload. A null payload (the cron's) is `{ mode: 'stuck' }`. */
export type StorageRecoverPayload =
  | { mode: 'stuck'; olderThanMinutes?: number }
  | { mode: 'failed'; limit?: number };

/** `media.storage.reprocess` payload. No `circleId`: every circle. */
export interface StorageReprocessPayload {
  circleId?: string;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Reads a `media.storage.recover_stuck` payload. Anything unrecognised degrades
 * to the cron's default (`stuck`, env threshold), never to a throw: the sweep is
 * idempotent, so running it is always safe.
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

/** Reads a `media.storage.reprocess` payload; a missing or malformed `circleId` means every circle. */
export function parseReprocessPayload(payload: unknown): StorageReprocessPayload {
  const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const circleId = raw['circleId'];
  return typeof circleId === 'string' && circleId.length > 0 ? { circleId } : {};
}

/** `STORAGE_PROCESSING_STUCK_MINUTES`, else the default. */
export function stuckMinutesFromEnv(): number {
  const parsed = parseInt(process.env['STORAGE_PROCESSING_STUCK_MINUTES'] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STUCK_MINUTES;
}

/** `STORAGE_PROCESSING_MAX_RETRIES`, else the default. */
export function maxRetriesFromEnv(): number {
  const parsed = parseInt(process.env['STORAGE_PROCESSING_MAX_RETRIES'] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_RETRIES;
}

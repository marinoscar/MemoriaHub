import { api } from './api';

/**
 * Result of `POST /api/admin/memories/backfill` (epic #300, issue #315).
 *
 * `enqueued` counts job ROWS, not circles: a library backfill is sharded into
 * several `memory_generation` jobs per circle so no single job can approach the
 * worker's execution timeout on a large library. `circles` is how many circles
 * got jobs, and `skipped` how many were left alone because a generation job was
 * already pending or running for them.
 */
export interface MemoriesBackfillResult {
  enqueued: number;
  circles: number;
  skipped: number;
}

/** Sweep the existing library. Omit `circleId` to cover every circle. */
export async function runMemoriesBackfill(body?: {
  circleId?: string;
}): Promise<MemoriesBackfillResult> {
  return api.post<MemoriesBackfillResult>('/admin/memories/backfill', body ?? {});
}

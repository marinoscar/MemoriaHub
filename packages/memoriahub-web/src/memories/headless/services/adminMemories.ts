import { api } from '../../../core/headless/index.js';

/**
 * Result of `POST /api/admin/memories/backfill` (epic #300, issue #315).
 *
 * `enqueued` counts job ROWS, not circles: a library backfill is sharded into
 * several `memory_generation` jobs per circle so no single job can approach the
 * worker's execution timeout on a large library. `circles` is how many circles
 * got jobs, and `skipped` how many were left alone because a generation job was
 * already pending or running for them.
 *
 * @stability experimental
 */
export interface MemoriesBackfillResult {
  enqueued: number;
  circles: number;
  skipped: number;
}

/**
 * Sweeps the existing library. Omit `circleId` to cover every circle.
 *
 * @param body - the circle to cover.
 * @returns how many jobs were enqueued.
 *
 * @stability experimental
 */
export async function runMemoriesBackfill(body?: {
  circleId?: string;
}): Promise<MemoriesBackfillResult> {
  return api.post<MemoriesBackfillResult>('/admin/memories/backfill', body ?? {});
}

/**
 * One library the backfill can target (RETRO-I6, #588): a group, or a user's personal library.
 *
 * @stability experimental
 */
export interface MemoriesBackfillLibrary {
  /** The id the backfill takes as `circleId`. */
  id: string;
  kind: 'group' | 'personal';
  /** The group's name, or the owner's name for a personal library. */
  name: string;
}

/**
 * The libraries for the backfill picker (`GET /api/admin/memories/libraries`, admin only).
 *
 * @returns the libraries.
 *
 * @stability experimental
 */
export async function listMemoriesBackfillLibraries(): Promise<MemoriesBackfillLibrary[]> {
  const res = await api.get<{ items: MemoriesBackfillLibrary[] }>('/admin/memories/libraries');
  return res.items;
}

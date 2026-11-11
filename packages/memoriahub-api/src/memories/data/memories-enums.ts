// =============================================================================
// The enum values the memories slice names
// =============================================================================
//
// The values of the domain schema's enums (`MemoryType`, `MediaType`, `MediaTagSource`), as plain
// string constants: the slice imports no generated client. The strings are what the database stores
// and never change. `MemoryType` is the contract's `MEMORY_TYPES`.
// =============================================================================

import type { MemoryTypeValue } from '@marinoscar/memoriahub-contract/memories';

/**
 * `MemoryType`: the seven kinds of memory.
 *
 * @stability experimental
 */
export const MemoryType = {
  on_this_day: 'on_this_day',
  trip: 'trip',
  person_highlights: 'person_highlights',
  person_over_years: 'person_over_years',
  theme: 'theme',
  seasonal: 'seasonal',
  year_in_review: 'year_in_review',
} as const satisfies Record<MemoryTypeValue, MemoryTypeValue>;

/** One value of {@link MemoryType}. @stability experimental */
export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];

/**
 * `MediaType`: a photo or a video.
 *
 * @stability experimental
 */
export const MediaType = { photo: 'photo', video: 'video' } as const;

/** One value of {@link MediaType}. @stability experimental */
export type MediaType = (typeof MediaType)[keyof typeof MediaType];

/**
 * `MediaTagSource`: who applied a tag.
 *
 * @stability experimental
 */
export const MediaTagSource = { manual: 'manual', ai: 'ai', system: 'system' } as const;

/** One value of {@link MediaTagSource}. @stability experimental */
export type MediaTagSource = (typeof MediaTagSource)[keyof typeof MediaTagSource];

/**
 * `JobReason`: why a job was queued (the queue has no `scheduled` reason; `backfill` is what every
 * cron-enqueued job uses).
 *
 * @stability experimental
 */
export const JobReason = { upload: 'upload', rerun: 'rerun', backfill: 'backfill' } as const;

/** One value of {@link JobReason}. @stability experimental */
export type JobReason = (typeof JobReason)[keyof typeof JobReason];

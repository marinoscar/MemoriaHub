import { z } from 'zod';

/**
 * The seven kinds of memory, in the order of the `MemoryType` database enum.
 *
 * @stability stable
 */
export const MEMORY_TYPES = [
  'on_this_day',
  'trip',
  'person_highlights',
  'person_over_years',
  'theme',
  'seasonal',
  'year_in_review',
] as const;

/**
 * One memory type.
 *
 * @stability stable
 */
export type MemoryTypeValue = (typeof MEMORY_TYPES)[number];

/**
 * Zod schema of {@link MEMORY_TYPES}.
 *
 * @stability stable
 */
export const memoryTypeSchema = z.enum(MEMORY_TYPES);

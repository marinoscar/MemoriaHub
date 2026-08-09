import { MemoryType } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Query for `GET /api/memories` (epic #300, issue #307).
 *
 * KEYSET ONLY — there is deliberately no `page` escape hatch the way
 * `GET /api/media` has one. That endpoint's offset mode exists purely for
 * legacy clients (the Android app, the CLI) that predate keyset; nothing has
 * ever consumed memories, so the dual-mode complexity and its `COUNT(*)` are
 * not inherited.
 *
 * `year` is not a column — a memory covers a RANGE. It is compiled to an
 * overlap test against that calendar year in UTC (see MemoriesService), so a
 * trip spanning New Year's Eve appears under BOTH years, which is what a user
 * filtering "2023" expects of a photo taken on 2023-12-31.
 */
export const memoryListQuerySchema = z.object({
  circleId: z.string().uuid(),
  type: z.nativeEnum(MemoryType).optional(),
  year: z.coerce.number().int().min(1900).max(3000).optional(),
  /** `true` narrows to the caller's own favorites; anything else is ignored. */
  favorite: z
    .string()
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
  cursor: z.string().uuid().optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export class MemoryListQueryDto extends createZodDto(memoryListQuerySchema) {}

/** Query for `GET /api/memories/feed` — circle scope only; the cap is fixed. */
export const memoryFeedQuerySchema = z.object({
  circleId: z.string().uuid(),
});

export class MemoryFeedQueryDto extends createZodDto(memoryFeedQuerySchema) {}

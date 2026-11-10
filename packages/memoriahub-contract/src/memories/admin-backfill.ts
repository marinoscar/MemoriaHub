import { z } from 'zod';

/**
 * Body of `POST /api/admin/memories/backfill`.
 *
 * @stability experimental
 */
export const adminMemoriesBackfillSchema = z
  .object({
    /** Omit to sweep every circle in the deployment. */
    circleId: z.string().uuid().optional(),
    // .prefault({}) so a bodyless POST parses exactly like {}, issue #289.
  })
  .prefault({});

/**
 * The parsed value of {@link adminMemoriesBackfillSchema}.
 *
 * @stability experimental
 */
export type AdminMemoriesBackfill = z.infer<typeof adminMemoriesBackfillSchema>;

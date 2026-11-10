import { z } from 'zod';


/**
 * POST /api/media/trash/empty — start an async empty-trash run for a circle.
 *
 * @stability experimental
 */
export const createTrashEmptyRunSchema = z.object({
  circleId: z.string().uuid(),
});

/**
 * The parsed value of {@link createTrashEmptyRunSchema}.
 *
 * @stability experimental
 */
export type CreateTrashEmptyRun = z.infer<typeof createTrashEmptyRunSchema>;

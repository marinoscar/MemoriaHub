import { z } from 'zod';


/**
 * Wire schema `emptyTrashSchema`.
 *
 * @stability experimental
 */
export const emptyTrashSchema = z.object({
  circleId: z.string().uuid(),
});

/**
 * The parsed value of {@link emptyTrashSchema}.
 *
 * @stability experimental
 */
export type EmptyTrash = z.infer<typeof emptyTrashSchema>;

import { z } from 'zod';


/**
 * Wire schema `restoreFromTrashSchema`.
 *
 * @stability experimental
 */
export const restoreFromTrashSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * The parsed value of {@link restoreFromTrashSchema}.
 *
 * @stability experimental
 */
export type RestoreFromTrash = z.infer<typeof restoreFromTrashSchema>;

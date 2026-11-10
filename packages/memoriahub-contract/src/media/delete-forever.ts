import { z } from 'zod';


/**
 * Wire schema `deleteForeverSchema`.
 *
 * @stability experimental
 */
export const deleteForeverSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * The parsed value of {@link deleteForeverSchema}.
 *
 * @stability experimental
 */
export type DeleteForever = z.infer<typeof deleteForeverSchema>;

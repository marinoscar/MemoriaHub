import { z } from 'zod';


// `GET /api/media/shared-with-me` and `GET /api/media/albums/shared-with-me` (RETRO-I6, #588):
// no owner scope, the records come from the caller's grants.
/**
 * Wire schema `sharedWithMeQuerySchema`.
 *
 * @stability experimental
 */
export const sharedWithMeQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The parsed value of {@link sharedWithMeQuerySchema}.
 *
 * @stability experimental
 */
export type SharedWithMeQuery = z.infer<typeof sharedWithMeQuerySchema>;

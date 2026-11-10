import { z } from 'zod';


/**
 * Wire schema `mediaThumbnailsQuerySchema`.
 *
 * @stability experimental
 */
export const mediaThumbnailsQuerySchema = z.object({
  circleId: z.string().uuid(),
  // Comma-separated list of media item UUIDs (1–200), transformed to string[].
  ids: z
    .string()
    .transform((val) =>
      val
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    .pipe(z.array(z.string().uuid()).min(1).max(200)),
});

/**
 * The parsed value of {@link mediaThumbnailsQuerySchema}.
 *
 * @stability experimental
 */
export type MediaThumbnailsQuery = z.infer<typeof mediaThumbnailsQuerySchema>;

import { z } from 'zod';
import { isoDateTimeInput } from '../primitives/index.js';


// Not viewport-scoped (no precision/bbox) — this endpoint covers the whole
// circle's geotagged media, used to compute the TRUE bounding box for
// initial map framing rather than an arbitrary default viewport.
/**
 * Wire schema `mediaLocationsExtentQuerySchema`.
 *
 * @stability experimental
 */
export const mediaLocationsExtentQuerySchema = z.object({
  circleId: z.string().uuid(),
  // Date range filters
  capturedAtFrom: isoDateTimeInput.optional(),
  capturedAtTo: isoDateTimeInput.optional(),
  // Type filter
  type: z.enum(['photo', 'video']).optional(),
});

/**
 * The parsed value of {@link mediaLocationsExtentQuerySchema}.
 *
 * @stability experimental
 */
export type MediaLocationsExtentQuery = z.infer<typeof mediaLocationsExtentQuerySchema>;

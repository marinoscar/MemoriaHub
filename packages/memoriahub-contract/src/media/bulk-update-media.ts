import { z } from 'zod';
import { isoDateTimeInput } from '../primitives/index.js';


const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  altitude: z.number().optional(),
});

/**
 * Wire schema `bulkUpdateMediaSchema`.
 *
 * @stability experimental
 */
export const bulkUpdateMediaSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(500),
  set: z.object({
    location: locationSchema.nullable().optional(),
    favorite: z.boolean().optional(),
    capturedAt: isoDateTimeInput.nullable().optional(),
  }).refine(
    (s) => s.location !== undefined || s.favorite !== undefined || s.capturedAt !== undefined,
    { message: 'set must contain at least one field' },
  ),
});

/**
 * The parsed value of {@link bulkUpdateMediaSchema}.
 *
 * @stability experimental
 */
export type BulkUpdateMedia = z.infer<typeof bulkUpdateMediaSchema>;

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTimeInput } from '../../common/schemas/iso-date';

// Not viewport-scoped (no precision/bbox) — this endpoint covers the whole
// circle's geotagged media, used to compute the TRUE bounding box for
// initial map framing rather than an arbitrary default viewport.
export const mediaLocationsExtentQuerySchema = z.object({
  circleId: z.string().uuid(),
  // Date range filters
  capturedAtFrom: isoDateTimeInput.optional(),
  capturedAtTo: isoDateTimeInput.optional(),
  // Type filter
  type: z.enum(['photo', 'video']).optional(),
});

export class MediaLocationsExtentQueryDto extends createZodDto(
  mediaLocationsExtentQuerySchema,
) {}

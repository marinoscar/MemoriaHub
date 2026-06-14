import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTimeInput } from '../../common/schemas/iso-date';

export const mediaLocationsQuerySchema = z.object({
  circleId: z.string().uuid(),
  // Type filter
  type: z.enum(['photo', 'video']).optional(),
  // Date range filters
  capturedAtFrom: isoDateTimeInput.optional(),
  capturedAtTo: isoDateTimeInput.optional(),
  // Geo filters (individual)
  country: z.string().optional(),
  region: z.string().optional(),
  locality: z.string().optional(),
  place: z.string().optional(),
  // Combined free-text geo search
  location: z.string().optional(),
});

export class MediaLocationsQueryDto extends createZodDto(mediaLocationsQuerySchema) {}

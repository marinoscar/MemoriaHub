import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTimeInput } from '../../common/schemas/iso-date';
import { bboxInput } from './bbox.util';

export const mediaLocationsQuerySchema = z.object({
  circleId: z.string().uuid(),
  // Type filter
  type: z.enum(['photo', 'video']).optional(),
  // Date range filters
  capturedAtFrom: isoDateTimeInput.optional(),
  capturedAtTo: isoDateTimeInput.optional(),
  // Viewport bounding box "minLng,minLat,maxLng,maxLat"
  bbox: bboxInput.optional(),
  // Geo filters (individual)
  country: z.string().optional(),
  region: z.string().optional(),
  locality: z.string().optional(),
  place: z.string().optional(),
  // Combined free-text geo search
  location: z.string().optional(),
  // Scope the map to a single album's members
  albumId: z.string().uuid().optional(),
});

export class MediaLocationsQueryDto extends createZodDto(mediaLocationsQuerySchema) {}

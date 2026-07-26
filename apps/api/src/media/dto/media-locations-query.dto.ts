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
  // Optional cap on the number of points returned. Bounds a PREVIEW fetch — the
  // map's cluster drawer asks for one cluster's bbox but only renders a couple
  // dozen thumbnails, so it should not pull thousands of rows. Combined with the
  // endpoint's `capturedAt desc` ordering this yields "the most recent N in the
  // box". Deliberately optional: the full-album map view needs every point.
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export class MediaLocationsQueryDto extends createZodDto(mediaLocationsQuerySchema) {}

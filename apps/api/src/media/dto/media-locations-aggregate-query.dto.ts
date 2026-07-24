import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTimeInput } from '../../common/schemas/iso-date';
import { bboxInput } from './bbox.util';

export const mediaLocationsAggregateQuerySchema = z.object({
  circleId: z.string().uuid(),
  // Spatial clustering precision — number of decimal places to round
  // taken_lat/taken_lng to before grouping (0 = ~111km cells, 5 = ~1m cells).
  precision: z.coerce.number().int().min(0).max(5).default(3),
  // Optional map zoom level (0–22). When provided, clustering switches from the
  // legacy equirectangular lat/lng round() grid to a Web-Mercator pixel-uniform
  // grid keyed to this zoom, so clusters are evenly spaced at every latitude.
  zoom: z.coerce.number().int().min(0).max(22).optional(),
  // Viewport bounding box "minLng,minLat,maxLng,maxLat"
  bbox: bboxInput.optional(),
  // Date range filters
  capturedAtFrom: isoDateTimeInput.optional(),
  capturedAtTo: isoDateTimeInput.optional(),
  // Type filter
  type: z.enum(['photo', 'video']).optional(),
});

export class MediaLocationsAggregateQueryDto extends createZodDto(
  mediaLocationsAggregateQuerySchema,
) {}

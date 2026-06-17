import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTimeInput } from '../../common/schemas/iso-date';

export const mediaQuerySchema = z.object({
  circleId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  // Type / date filters
  type: z.enum(['photo', 'video']).optional(),
  capturedAtFrom: isoDateTimeInput.optional(),
  capturedAtTo: isoDateTimeInput.optional(),
  classification: z.enum(['memory', 'low_value', 'unreviewed']).optional(),
  albumId: z.string().uuid().optional(),
  favorite: z
    .string()
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
  tag: z.string().optional(),
  // Geo filters (individual)
  country: z.string().optional(),
  region: z.string().optional(),
  locality: z.string().optional(),
  place: z.string().optional(),
  // Combined free-text geo search
  location: z.string().optional(),
  // Dedup filter (used by CLI importer)
  contentHash: z.string().optional(),
  // Sort
  sortBy: z.enum(['capturedAt', 'importedAt', 'createdAt']).default('capturedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  cameraMake: z.string().optional(),
  cameraModel: z.string().optional(),
  sourceDeviceId: z.string().optional(),
  sourceDeviceName: z.string().optional(),
  missingGeo: z.string().optional().transform(v => v === 'true' ? true : v === 'false' ? false : undefined),
  personId: z.string().uuid().optional(),
});

export class MediaQueryDto extends createZodDto(mediaQuerySchema) {}

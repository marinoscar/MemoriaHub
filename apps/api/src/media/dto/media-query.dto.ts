import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTimeInput } from '../../common/schemas/iso-date';

/**
 * Shared filter fields for media queries (everything except pagination and sort).
 * Export this shape so other DTOs (e.g. AddAlbumItemsByFilterDto) can reuse it.
 */
export const mediaFilterFields = {
  circleId: z.string().uuid().optional(),
  // Type / date filters
  type: z.enum(['photo', 'video']).optional(),
  capturedAtFrom: isoDateTimeInput.optional(),
  capturedAtTo: isoDateTimeInput.optional(),
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
  cameraMake: z.string().optional(),
  cameraModel: z.string().optional(),
  sourceDeviceId: z.string().optional(),
  sourceDeviceName: z.string().optional(),
  missingGeo: z.string().optional().transform(v => v === 'true' ? true : v === 'false' ? false : undefined),
  noFaces: z.string().optional().transform(v => v === 'true' ? true : v === 'false' ? false : undefined),
  personId: z.string().uuid().optional(),
  // Multi-person filter: accepts comma-separated string or repeated query params
  personIds: z
    .preprocess(
      (v) => {
        if (v === undefined || v === null) return undefined;
        if (Array.isArray(v)) return v.flatMap((s) => (typeof s === 'string' ? s.split(',').map((x) => x.trim()).filter(Boolean) : []));
        if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
        return undefined;
      },
      z.array(z.string().uuid()).optional(),
    )
    .optional(),
  peopleMatch: z.enum(['any', 'all']).optional().default('any'),
};

export const mediaQuerySchema = z.object({
  ...mediaFilterFields,
  // circleId is required in the list endpoint (override the optional from shared fields)
  circleId: z.string().uuid(),
  // Pagination / sort (not shared)
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['capturedAt', 'importedAt', 'createdAt']).default('capturedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export class MediaQueryDto extends createZodDto(mediaQuerySchema) {}

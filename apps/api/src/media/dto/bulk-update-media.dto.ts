import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  altitude: z.number().optional(),
});

export const bulkUpdateMediaSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(500),
  set: z.object({
    location: locationSchema.nullable().optional(),
    favorite: z.boolean().optional(),
  }).refine(
    (s) => s.location !== undefined || s.favorite !== undefined,
    { message: 'set must contain at least one field' },
  ),
});

export class BulkUpdateMediaDto extends createZodDto(bulkUpdateMediaSchema) {}

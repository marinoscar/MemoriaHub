import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const geoSearchQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export class GeoSearchQueryDto extends createZodDto(geoSearchQuerySchema) {}

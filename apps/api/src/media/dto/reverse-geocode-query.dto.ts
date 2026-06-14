import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const reverseGeocodeQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

export class ReverseGeocodeQueryDto extends createZodDto(reverseGeocodeQuerySchema) {}

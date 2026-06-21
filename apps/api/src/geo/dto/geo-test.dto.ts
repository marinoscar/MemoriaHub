import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const testGeoProviderSchema = z.object({
  provider: z.enum(['offline', 'nominatim', 'google']),
  lat: z.number().optional(),
  lng: z.number().optional(),
});
export class TestGeoProviderDto extends createZodDto(testGeoProviderSchema) {}

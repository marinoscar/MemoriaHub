import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const setGeoReverseProviderSchema = z.object({
  provider: z.enum(['offline', 'nominatim', 'google']),
});
export class SetGeoReverseProviderDto extends createZodDto(setGeoReverseProviderSchema) {}

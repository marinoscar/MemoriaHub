import { z } from 'zod';


/**
 * Wire schema `testGeoProviderSchema`.
 *
 * @stability experimental
 */
export const testGeoProviderSchema = z.object({
  provider: z.enum(['offline', 'nominatim', 'google']),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

/**
 * The parsed value of {@link testGeoProviderSchema}.
 *
 * @stability experimental
 */
export type TestGeoProvider = z.infer<typeof testGeoProviderSchema>;

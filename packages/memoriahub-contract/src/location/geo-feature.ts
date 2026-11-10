import { z } from 'zod';


/**
 * Wire schema `setGeoReverseProviderSchema`.
 *
 * @stability experimental
 */
export const setGeoReverseProviderSchema = z.object({
  provider: z.enum(['offline', 'nominatim', 'google']),
});

/**
 * The parsed value of {@link setGeoReverseProviderSchema}.
 *
 * @stability experimental
 */
export type SetGeoReverseProvider = z.infer<typeof setGeoReverseProviderSchema>;

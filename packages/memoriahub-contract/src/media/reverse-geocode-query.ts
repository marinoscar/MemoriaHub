import { z } from 'zod';


/**
 * Wire schema `reverseGeocodeQuerySchema`.
 *
 * @stability experimental
 */
export const reverseGeocodeQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

/**
 * The parsed value of {@link reverseGeocodeQuerySchema}.
 *
 * @stability experimental
 */
export type ReverseGeocodeQuery = z.infer<typeof reverseGeocodeQuerySchema>;

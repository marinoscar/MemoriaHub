import { z } from 'zod';


/**
 * Wire schema `upsertGeoCredentialSchema`.
 *
 * @stability experimental
 */
export const upsertGeoCredentialSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().optional(),
});

/**
 * The parsed value of {@link upsertGeoCredentialSchema}.
 *
 * @stability experimental
 */
export type UpsertGeoCredential = z.infer<typeof upsertGeoCredentialSchema>;

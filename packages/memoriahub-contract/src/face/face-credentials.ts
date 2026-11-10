import { z } from 'zod';


// apiKey is optional because CompreFace (the only face provider) is keyless —
// a credential row for it, if present at all, stores only an optional
// baseUrl override.
/**
 * Wire schema `upsertFaceCredentialsSchema`.
 *
 * @stability experimental
 */
export const upsertFaceCredentialsSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().optional(),
  // .default({}) so a bodyless request parses as {} — see issue #289 (app.module.ts).
}).default({});

// No model field — face providers have a fixed modelVersion per deployment
/**
 * Wire schema `testFaceProviderSchema`.
 *
 * @stability experimental
 */
export const testFaceProviderSchema = z.object({
  provider: z.string().min(1),
});

/**
 * Wire schema `setDetectionFeatureSchema`.
 *
 * @stability experimental
 */
export const setDetectionFeatureSchema = z.object({
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
});

/**
 * The parsed value of {@link upsertFaceCredentialsSchema}.
 *
 * @stability experimental
 */
export type UpsertFaceCredentials = z.infer<typeof upsertFaceCredentialsSchema>;

/**
 * The parsed value of {@link testFaceProviderSchema}.
 *
 * @stability experimental
 */
export type TestFaceProvider = z.infer<typeof testFaceProviderSchema>;

/**
 * The parsed value of {@link setDetectionFeatureSchema}.
 *
 * @stability experimental
 */
export type SetDetectionFeature = z.infer<typeof setDetectionFeatureSchema>;

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// apiKey is optional because CompreFace is keyless — a credential row only ever
// needs to carry an optional baseUrl override.
export const upsertFaceCredentialsSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().optional(),
});
export class UpsertFaceCredentialsDto extends createZodDto(upsertFaceCredentialsSchema) {}

// No model field — face providers have a fixed modelVersion per deployment
export const testFaceProviderSchema = z.object({
  provider: z.string().min(1),
});
export class TestFaceProviderDto extends createZodDto(testFaceProviderSchema) {}

export const setDetectionFeatureSchema = z.object({
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
});
export class SetDetectionFeatureDto extends createZodDto(setDetectionFeatureSchema) {}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const upsertCredentialsSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().optional(),
});
export class UpsertAiCredentialsDto extends createZodDto(upsertCredentialsSchema) {}

export const testProviderSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export class TestAiProviderDto extends createZodDto(testProviderSchema) {}

export const setSearchFeatureSchema = z.object({
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
});
export class SetSearchFeatureDto extends createZodDto(setSearchFeatureSchema) {}

export const setTaggingFeatureSchema = z.object({
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
});
export class SetTaggingFeatureDto extends createZodDto(setTaggingFeatureSchema) {}

export const setEmbeddingFeatureSchema = z.object({
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
});
export class SetEmbeddingFeatureDto extends createZodDto(setEmbeddingFeatureSchema) {}

export const setEnhanceFeatureSchema = z.object({
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
});
export class SetEnhanceFeatureDto extends createZodDto(setEnhanceFeatureSchema) {}

// Memories title/subtitle/narrative generation (epic #300, issue #302).
// Same nullable pair shape as `enhance`: clearing either field clears the
// whole selection, since a half-filled provider/model pair is not usable.
export const setMemoriesFeatureSchema = z.object({
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
});
export class SetMemoriesFeatureDto extends createZodDto(setMemoriesFeatureSchema) {}

// Both fields optional — an empty body tests the configured ai.features.embedding.
// .default({}) so a bodyless POST parses as {} — see issue #289 (app.module.ts).
export const testEmbeddingSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
}).default({});
export class TestEmbeddingDto extends createZodDto(testEmbeddingSchema) {}

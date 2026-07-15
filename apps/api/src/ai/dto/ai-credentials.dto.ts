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

export const testEmbeddingSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
export class TestEmbeddingDto extends createZodDto(testEmbeddingSchema) {}

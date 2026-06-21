import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const testStorageProviderSchema = z.object({
  provider: z.string().min(1),
  // Optional credential overrides for ephemeral test (not yet persisted)
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  bucket: z.string().optional(),
  region: z.string().optional(),
  endpoint: z.string().url().optional(),
});
export class TestStorageProviderDto extends createZodDto(testStorageProviderSchema) {}

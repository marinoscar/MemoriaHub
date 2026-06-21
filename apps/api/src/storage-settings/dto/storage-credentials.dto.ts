import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// All fields are optional here; per-provider validation is enforced in the service.
export const upsertStorageCredentialsSchema = z.object({
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  bucket: z.string().optional(),
  region: z.string().optional(),
  endpoint: z.string().url().optional(),
  enabled: z.boolean().optional(),
});
export class UpsertStorageCredentialsDto extends createZodDto(upsertStorageCredentialsSchema) {}

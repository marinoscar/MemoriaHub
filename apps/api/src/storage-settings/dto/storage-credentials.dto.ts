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
  // .default({}) so a bodyless request parses as {} — see issue #289 (app.module.ts).
}).default({});
export class UpsertStorageCredentialsDto extends createZodDto(upsertStorageCredentialsSchema) {}

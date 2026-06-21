import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const upsertGeoCredentialSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().optional(),
});
export class UpsertGeoCredentialDto extends createZodDto(upsertGeoCredentialSchema) {}

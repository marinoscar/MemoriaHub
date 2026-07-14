import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateEmailSettingsSchema = z.object({
  provider: z.enum(['ses', 'smtp']).nullable(),
  enabled: z.boolean(),
  sesRegion: z.string().nullable().optional(),
  smtpHost: z.string().nullable().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpUseTls: z.boolean().optional(),
  smtpUsername: z.string().nullable().optional(),
  // Plaintext password from the admin form. Blank/omitted PRESERVES the stored
  // ciphertext; a non-empty value is AES-256-GCM encrypted before persistence.
  smtpPassword: z.string().optional(),
  fromAddress: z.string().email().nullable().optional(),
  fromName: z.string().nullable().optional(),
});

export class UpdateEmailSettingsDto extends createZodDto(updateEmailSettingsSchema) {}

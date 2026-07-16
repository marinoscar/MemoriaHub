import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createNodeCredentialSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
  // Optional ISO 8601 expiry; omitted or null = the credential never expires
  // (worker nodes are long-lived daemons, unlike short-lived PATs).
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export class CreateNodeCredentialDto extends createZodDto(createNodeCredentialSchema) {}

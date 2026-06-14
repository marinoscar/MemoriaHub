import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CircleRole } from '@prisma/client';

export const createInviteSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase()),
  role: z.nativeEnum(CircleRole).default(CircleRole.viewer),
  notes: z.string().max(500).optional(),
});
export class CreateInviteDto extends createZodDto(createInviteSchema) {}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { circleRoleSchema } from '../circle-role';

export const createInviteSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase()),
  role: circleRoleSchema.default('viewer'),
  notes: z.string().max(500).optional(),
});
export class CreateInviteDto extends createZodDto(createInviteSchema) {}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CircleRole } from '@prisma/client';

export const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.nativeEnum(CircleRole).default(CircleRole.viewer),
});
export class AddMemberDto extends createZodDto(addMemberSchema) {}

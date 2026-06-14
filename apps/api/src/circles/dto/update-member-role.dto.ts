import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CircleRole } from '@prisma/client';

export const updateMemberRoleSchema = z.object({
  role: z.nativeEnum(CircleRole),
});
export class UpdateMemberRoleDto extends createZodDto(updateMemberRoleSchema) {}

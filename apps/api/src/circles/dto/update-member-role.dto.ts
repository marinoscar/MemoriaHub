import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { circleRoleSchema } from '../circle-role';

export const updateMemberRoleSchema = z.object({
  role: circleRoleSchema,
});
export class UpdateMemberRoleDto extends createZodDto(updateMemberRoleSchema) {}

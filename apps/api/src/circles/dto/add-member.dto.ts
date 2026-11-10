import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { circleRoleSchema } from '../circle-role';

export const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: circleRoleSchema.default('viewer'),
});
export class AddMemberDto extends createZodDto(addMemberSchema) {}

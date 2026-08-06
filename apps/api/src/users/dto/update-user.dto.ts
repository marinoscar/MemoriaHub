import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateUserSchema = z.object({
  displayName: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
  // .default({}) so a bodyless request parses as {} — see issue #289 (app.module.ts).
}).default({});

export class UpdateUserDto extends createZodDto(updateUserSchema) {}

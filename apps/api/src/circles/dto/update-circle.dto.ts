import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateCircleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullish(),
  // .default({}) so a bodyless request parses as {} — see issue #289 (app.module.ts).
}).default({});
export class UpdateCircleDto extends createZodDto(updateCircleSchema) {}

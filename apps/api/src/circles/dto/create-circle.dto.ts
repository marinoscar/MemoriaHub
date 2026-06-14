import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createCircleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});
export class CreateCircleDto extends createZodDto(createCircleSchema) {}

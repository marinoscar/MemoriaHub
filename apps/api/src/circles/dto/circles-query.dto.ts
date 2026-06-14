import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const circlesQuerySchema = z.object({
  all: z.coerce.boolean().default(false),
});
export class CirclesQueryDto extends createZodDto(circlesQuerySchema) {}

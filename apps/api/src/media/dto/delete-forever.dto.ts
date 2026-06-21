import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const deleteForeverSchema = z.object({
  circleId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(500),
});

export class DeleteForeverDto extends createZodDto(deleteForeverSchema) {}

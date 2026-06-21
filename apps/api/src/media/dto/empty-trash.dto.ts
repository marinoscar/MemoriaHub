import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const emptyTrashSchema = z.object({
  circleId: z.string().uuid(),
});

export class EmptyTrashDto extends createZodDto(emptyTrashSchema) {}

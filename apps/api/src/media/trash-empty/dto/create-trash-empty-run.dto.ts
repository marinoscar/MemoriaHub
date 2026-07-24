import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** POST /api/media/trash/empty — start an async empty-trash run for a circle. */
export const createTrashEmptyRunSchema = z.object({
  circleId: z.string().uuid(),
});

export class CreateTrashEmptyRunDto extends createZodDto(createTrashEmptyRunSchema) {}

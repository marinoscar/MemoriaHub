import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const listTrashQuerySchema = z.object({
  circleId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export class ListTrashQueryDto extends createZodDto(listTrashQuerySchema) {}

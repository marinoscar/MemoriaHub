import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const listArchivedQuerySchema = z.object({
  circleId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export class ListArchivedQueryDto extends createZodDto(listArchivedQuerySchema) {}

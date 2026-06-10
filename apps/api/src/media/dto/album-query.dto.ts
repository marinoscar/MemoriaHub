import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const albumQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['name', 'createdAt', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export class AlbumQueryDto extends createZodDto(albumQuerySchema) {}

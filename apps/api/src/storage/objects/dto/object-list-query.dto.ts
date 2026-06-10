import { z } from 'zod';
import { StorageObjectStatus } from '@prisma/client';
import { ObjectResponseDto } from './object-response.dto';

export const objectListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['pending', 'uploading', 'processing', 'ready', 'failed']).optional(),
  sortBy: z.enum(['createdAt', 'name', 'size']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type ObjectListQueryDto = z.infer<typeof objectListQuerySchema>;

export interface ObjectListResponseDto {
  items: ObjectResponseDto[];
  meta: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for POST /onedrive/import — start a background import of a OneDrive
 * folder into a target MemoriaHub circle. See docs/specs/onedrive-import.md §4, §5.
 */
export const startImportSchema = z.object({
  circleId: z.string().uuid('circleId must be a valid UUID'),
  /** OneDrive folder path relative to the drive root; omit for the drive root. */
  remoteFolderPath: z.string().max(2048).optional(),
  /** Walk subfolders when true. */
  recursive: z.boolean().optional(),
});

export class StartImportDto extends createZodDto(startImportSchema) {}

/** Pagination query for GET /onedrive/import/runs. */
export const listImportRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export class ListImportRunsQueryDto extends createZodDto(listImportRunsQuerySchema) {}

export class StartImportResponseDto {
  @ApiProperty({ description: 'The created import run id' })
  runId!: string;

  @ApiProperty({ description: 'Number of eligible image/video files discovered' })
  totalCount!: number;
}

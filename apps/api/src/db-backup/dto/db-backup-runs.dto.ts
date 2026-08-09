import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { ApiPropertyOptional } from '@nestjs/swagger';

const DB_BACKUP_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'stale',
] as const;

/**
 * Query schema for `GET /api/admin/db-backup/runs`.
 *
 * `z.coerce` is used for the numeric fields because query strings arrive as
 * strings; the top-level `.default({})` matches the app-wide rule for
 * all-optional query/body schemas (there is no refine here that a default
 * would bypass).
 */
export const ListDatabaseBackupRunsSchema = z
  .object({
    status: z.enum(DB_BACKUP_STATUSES).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .default({});

export class ListDatabaseBackupRunsDto extends createZodDto(
  ListDatabaseBackupRunsSchema,
) {
  @ApiPropertyOptional({ enum: DB_BACKUP_STATUSES })
  status?: (typeof DB_BACKUP_STATUSES)[number];

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  pageSize?: number;
}

/**
 * Query schema for `GET /api/admin/db-backup/runs/:id/download`.
 *
 * The bound mirrors `ObjectsService.getDownloadUrl`'s posture: a signed URL is
 * a bearer capability over a full database dump, so the ceiling is deliberately
 * hours, not days.
 */
export const DownloadDatabaseBackupSchema = z
  .object({
    expiresIn: z.coerce.number().int().min(60).max(86400).optional(),
  })
  .default({});

export class DownloadDatabaseBackupDto extends createZodDto(
  DownloadDatabaseBackupSchema,
) {
  @ApiPropertyOptional({
    description: 'Signed-URL lifetime in seconds (60–86400)',
    minimum: 60,
    maximum: 86400,
  })
  expiresIn?: number;
}

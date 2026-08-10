import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body schema for `PUT /api/admin/db-backup/config` (issue #343, epic #339).
 *
 * Mirrors the `databaseBackup` block of `systemSettingsPatchSchema`
 * (`apps/api/src/common/schemas/settings.schema.ts`) field-for-field: every key
 * is optional, so a caller can flip `enabled` without re-sending the whole
 * namespace, and the write is applied through `SystemSettingsService.patchSettings`
 * so the canonical schema validates it a second time.
 *
 * Two validations live in `DatabaseBackupAdminService` rather than here, because
 * both need runtime state a static schema cannot see:
 *   - `timezone` is checked against `Intl.supportedValuesOf('timeZone')`
 *   - `storageProvider` is checked against the CONFIGURED, ENABLED providers
 *
 * Deliberately NO top-level `.default({})`: an empty body is a legitimate no-op
 * here (unlike a schema whose top-level refine is what makes an empty body
 * invalid — see `app.module.ts` Caveat 2), and the app-wide rule in
 * `app.module.ts` only requires a default where an all-optional body must be
 * accepted when absent — this route always receives a body.
 */
export const UpdateDatabaseBackupConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    frequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(28).optional(),
    timeOfDay: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'timeOfDay must be "HH:mm"')
      .optional(),
    timezone: z.string().min(1).optional(),
    retentionCount: z.number().int().min(1).max(100).optional(),
    storageProvider: z.string().nullable().optional(),
    runStaleMinutes: z.number().int().min(5).max(240).optional(),
    compressionLevel: z.number().int().min(0).max(9).optional(),
    restoreRollbackMode: z
      .enum(['retain_database', 'pre_restore_dump'])
      .optional(),
    oldDatabaseRetentionHours: z.number().int().min(1).max(720).optional(),
  })
  .strict();

export class UpdateDatabaseBackupConfigDto extends createZodDto(
  UpdateDatabaseBackupConfigSchema,
) {
  @ApiPropertyOptional({ description: 'Whether scheduled backups run at all' })
  enabled?: boolean;

  @ApiPropertyOptional({ enum: ['daily', 'weekly', 'monthly'] })
  frequency?: 'daily' | 'weekly' | 'monthly';

  @ApiPropertyOptional({
    description: 'Day of week for weekly schedules (0 = Sunday)',
    minimum: 0,
    maximum: 6,
  })
  dayOfWeek?: number;

  @ApiPropertyOptional({
    description: 'Day of month for monthly schedules (1–28)',
    minimum: 1,
    maximum: 28,
  })
  dayOfMonth?: number;

  @ApiPropertyOptional({ description: 'Local time of day, "HH:mm"' })
  timeOfDay?: string;

  @ApiPropertyOptional({
    description: 'IANA time zone the schedule is evaluated in',
  })
  timezone?: string;

  @ApiPropertyOptional({ description: 'How many completed backups to retain' })
  retentionCount?: number;

  @ApiPropertyOptional({
    description:
      'Storage provider override for the dump; null uses the active provider',
    nullable: true,
  })
  storageProvider?: string | null;

  @ApiPropertyOptional({
    description: 'Minutes without a heartbeat before a run is considered stale',
  })
  runStaleMinutes?: number;

  @ApiPropertyOptional({ description: 'pg_dump compression level (0–9)' })
  compressionLevel?: number;

  @ApiPropertyOptional({
    enum: ['retain_database', 'pre_restore_dump'],
    description: 'How a restore preserves a rollback path',
  })
  restoreRollbackMode?: 'retain_database' | 'pre_restore_dump';

  @ApiPropertyOptional({
    description: 'How long a renamed pre-restore database is kept, in hours',
  })
  oldDatabaseRetentionHours?: number;
}

import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The literal a caller must type to start a restore. */
export const RESTORE_CONFIRMATION = 'RESTORE';

/**
 * Body schema for `POST /api/admin/db-backup/runs/:id/restore` (issue #344).
 *
 * The typed confirmation is epic #339's scope decision, not ceremony: a restore
 * ends by renaming the live database and restarting the process, and it is the
 * one action in this feature that a mis-click cannot undo without a second
 * multi-hour operation. Requiring the literal string makes an accidental
 * `POST` — a retried request, a curl from shell history — a 400 rather than an
 * outage. It mirrors the Workflow engine's `"DELETE {matchedCount}"` gate.
 *
 * `overrideSchemaCheck` unblocks the compatibility gate ONLY. It can never
 * bypass a capability gate (no `CREATEDB`, no pgvector): those describe what
 * the cluster can physically do, and admin intent does not change them — that
 * path returns the guided-restore payload instead.
 */
export const RestoreDatabaseBackupSchema = z
  .object({
    confirmation: z.literal(RESTORE_CONFIRMATION, {
      message: `confirmation must be the literal string "${RESTORE_CONFIRMATION}"`,
    }),
    overrideSchemaCheck: z.boolean().optional(),
  })
  .strict();

export class RestoreDatabaseBackupDto extends createZodDto(
  RestoreDatabaseBackupSchema,
) {
  @ApiProperty({
    description: `Must be the literal string "${RESTORE_CONFIRMATION}"`,
    example: RESTORE_CONFIRMATION,
  })
  declare confirmation: typeof RESTORE_CONFIRMATION;

  @ApiPropertyOptional({
    description:
      'Proceed despite a schema-compatibility mismatch (restore old data, then run `prisma migrate deploy`). Never bypasses a capability gate.',
    default: false,
  })
  declare overrideSchemaCheck?: boolean;
}

/**
 * Body schema for `POST /api/admin/db-backup/runs/:id/rollback`.
 *
 * Same reasoning, different literal: in `retain_database` mode a rollback is
 * also a rename plus a restart, so it is equally unrecoverable by accident.
 */
export const ROLLBACK_CONFIRMATION = 'ROLLBACK';

export const RollbackDatabaseRestoreSchema = z
  .object({
    confirmation: z.literal(ROLLBACK_CONFIRMATION, {
      message: `confirmation must be the literal string "${ROLLBACK_CONFIRMATION}"`,
    }),
  })
  .strict();

export class RollbackDatabaseRestoreDto extends createZodDto(
  RollbackDatabaseRestoreSchema,
) {
  @ApiProperty({
    description: `Must be the literal string "${ROLLBACK_CONFIRMATION}"`,
    example: ROLLBACK_CONFIRMATION,
  })
  declare confirmation: typeof ROLLBACK_CONFIRMATION;
}

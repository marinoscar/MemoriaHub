import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { ROLES, PERMISSIONS } from '../common/constants/roles.constants';
import { DatabaseBackupAdminService } from './db-backup-admin.service';
import {
  DatabaseRestoreAlreadyRunningError,
  DatabaseRestoreNotAllowedError,
  DatabaseRestoreNotFoundError,
  DatabaseRestoreService,
} from './database-restore.service';
import { UpdateDatabaseBackupConfigDto } from './dto/db-backup-config.dto';
import {
  RestoreDatabaseBackupDto,
  RollbackDatabaseRestoreDto,
} from './dto/db-backup-restore.dto';
import {
  DownloadDatabaseBackupDto,
  ListDatabaseBackupRunsDto,
} from './dto/db-backup-runs.dto';

/**
 * DatabaseBackupController — `/api/admin/db-backup/*` (issue #343, epic #339).
 *
 * The admin HTTP surface for the PostgreSQL logical backup: schedule config,
 * manual trigger, run history and progress, signed download, delete, cancel.
 *
 * NOT to be confused with the two other backup features in this repo — see
 * CLAUDE.md's "Admin: Database Backup" section:
 *   - `/api/admin/backup/*`        media replication, S3 → server local disk
 *   - `/api/nodes/:id/backup/*`    Local Media Backup, node pull-mirror
 * This one is the only feature that backs up the DATABASE.
 *
 * Restore and rollback (`POST /runs/:id/restore`, `POST /runs/:id/rollback`,
 * #344) live at the bottom of this controller, behind `db_backup:restore` —
 * the separate permission exists because reading and scheduling backups is
 * routine while restoring one renames the live database and restarts the
 * process.
 */
@ApiTags('Admin - Database Backup')
@Controller('admin/db-backup')
export class DatabaseBackupController {
  constructor(
    private readonly service: DatabaseBackupAdminService,
    private readonly restoreService: DatabaseRestoreService,
  ) {}

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  @Get('config')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_READ] })
  @ApiOperation({
    summary: 'Get database backup schedule configuration',
    description:
      'Returns the `databaseBackup.*` settings namespace plus the COMPUTED next run time, so an admin can confirm the schedule means what they think, and the id of any run currently in progress.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Configuration, computed `nextRunAt` (ISO 8601, null when disabled), and `activeRunId`.',
  })
  async getConfig() {
    return this.service.getConfig();
  }

  @Put('config')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_WRITE] })
  @ApiOperation({
    summary: 'Update database backup schedule configuration',
    description:
      'Partial update — every field is optional. `timezone` is validated against the IANA zone list, and a `storageProvider` override must name a configured, ENABLED provider.',
  })
  @ApiResponse({ status: 200, description: 'Updated configuration.' })
  @ApiResponse({
    status: 400,
    description: 'Unknown time zone, or an unconfigured/disabled provider.',
  })
  async updateConfig(
    @Body() dto: UpdateDatabaseBackupConfigDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.updateConfig(dto, user.id);
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  @Post('runs')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_WRITE] })
  @ApiOperation({
    summary: 'Trigger a manual database backup',
    description:
      'Returns IMMEDIATELY with `{ runId, status }`; the dump takes tens of minutes and continues in the background. Poll `GET /runs/:id` for progress.',
  })
  @ApiResponse({ status: 201, description: '`{ runId, status }`.' })
  @ApiResponse({
    status: 409,
    description:
      'A run is already in progress. The active run id is carried in the standard error envelope as `details.activeRunId` (string, or null when the winning run finished before it could be looked up).',
    schema: {
      example: {
        statusCode: 409,
        code: 'CONFLICT',
        message: 'A database backup run is already in progress',
        details: { activeRunId: '3f8d…' },
        timestamp: '2026-08-10T12:00:00.000Z',
        path: '/api/admin/db-backup/runs',
      },
    },
  })
  async startRun(@CurrentUser() user: RequestUser) {
    return this.service.startRun(user.id);
  }

  @Get('runs')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_READ] })
  @ApiOperation({
    summary: 'List database backup runs',
    description:
      'Paginated history, newest first. `bytesWritten`/`sizeBytes` are serialized as STRINGS (BigInt columns).',
  })
  @ApiResponse({ status: 200, description: '`{ items, meta }`.' })
  async listRuns(@Query() query: ListDatabaseBackupRunsDto) {
    return this.service.listRuns(query);
  }

  @Get('runs/:id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_READ] })
  @ApiParam({ name: 'id', description: 'Database backup run id' })
  @ApiOperation({
    summary: 'Get a database backup run',
    description:
      'Progress-polling detail: status, `bytesWritten`, `lastHeartbeatAt`, `elapsedMs`, `verifiedAt`, `lastError`, and the restore/rollback audit fields.',
  })
  @ApiResponse({ status: 200, description: 'Run detail.' })
  @ApiResponse({ status: 404, description: 'Run not found.' })
  async getRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getRun(id);
  }

  @Get('runs/:id/download')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_READ] })
  @ApiParam({ name: 'id', description: 'Database backup run id' })
  @ApiOperation({
    summary: 'Get a signed download URL for a completed backup',
    description:
      'Signs against the provider RECORDED ON THE RUN, not the currently-active one, so a backup taken before a provider switch stays downloadable.',
  })
  @ApiResponse({ status: 200, description: '`{ url, expiresIn }`.' })
  @ApiResponse({
    status: 400,
    description: 'Run is not `completed`, or has no recorded storage location.',
  })
  @ApiResponse({ status: 404, description: 'Run not found.' })
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadDatabaseBackupDto,
  ) {
    return this.service.getDownloadUrl(id, query);
  }

  @Delete('runs/:id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_WRITE] })
  @ApiParam({ name: 'id', description: 'Database backup run id' })
  @ApiOperation({
    summary: 'Delete a backup run and its stored dump',
    description:
      'Deletes the storage object via the recorded provider FIRST, then hard-deletes the row. Refuses a run that is still pending or running — cancel it first.',
  })
  @ApiResponse({ status: 200, description: '`{ deleted, objectDeleted }`.' })
  @ApiResponse({ status: 400, description: 'Run is still in progress.' })
  @ApiResponse({ status: 404, description: 'Run not found.' })
  async deleteRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deleteRun(id);
  }

  @Post('runs/:id/cancel')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_WRITE] })
  @ApiParam({ name: 'id', description: 'Database backup run id' })
  @ApiOperation({
    summary: 'Cancel an in-flight database backup',
    description:
      'Cooperatively aborts the run: SIGTERMs the `pg_dump` child, tears the upload down, deletes the partial object, and marks the run failed. `signalled` is false when no in-process handle existed (another replica, or an orphaned row), in which case only the terminal bookkeeping is applied.',
  })
  @ApiResponse({ status: 201, description: '`{ runId, signalled }`.' })
  @ApiResponse({ status: 400, description: 'Run is not in progress.' })
  @ApiResponse({ status: 404, description: 'Run not found.' })
  async cancelRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancelRun(id);
  }

  // -------------------------------------------------------------------------
  // Restore / rollback (#344)
  // -------------------------------------------------------------------------

  @Post('runs/:id/restore')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_RESTORE] })
  @ApiParam({ name: 'id', description: 'Database backup run id to restore FROM' })
  @ApiOperation({
    summary: 'Restore the database from a completed backup',
    description:
      'Returns IMMEDIATELY once the cheap pre-flight gates have run; the restore itself takes HOURS (every HNSW index is rebuilt) and continues in the background, with the app fully up and serving on the live database throughout. Poll `GET /runs/:id` and watch `restoreStatus`.\n\n' +
      'Three normal outcomes, distinguished by `mode`:\n' +
      '- `running` — the restore started. It ends with a seconds-long database rename plus a process restart.\n' +
      '- `guided` — a CAPABILITY gate failed (no `CREATEDB`, no pgvector, no cluster admin connection). Not an error: the body carries a ready-to-paste, fully parameterized command block plus a runbook link.\n' +
      '- `blocked` — the schema-compatibility gate failed (the archive predates the running code). Re-send with `overrideSchemaCheck: true` to take the restore-then-`prisma migrate deploy` path.\n\n' +
      'Requires a single API replica, and a deployment restart policy (`restart: unless-stopped`) — the swap ends in `process.exit(0)`.',
  })
  @ApiResponse({
    status: 201,
    description: '`{ mode, preflight, ... }` — see the description.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Run is not `completed`, has no recorded storage location, or the confirmation literal is wrong.',
  })
  @ApiResponse({ status: 404, description: 'Run not found.' })
  @ApiResponse({
    status: 409,
    description:
      'Another restore is already in progress. The active run id is carried in the standard error envelope as `details.activeRunId`.',
    schema: {
      example: {
        statusCode: 409,
        code: 'CONFLICT',
        message: 'A database restore is already in progress (runId=3f8d…)',
        details: { activeRunId: '3f8d…' },
        timestamp: '2026-08-10T12:00:00.000Z',
        path: '/api/admin/db-backup/runs/{id}/restore',
      },
    },
  })
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RestoreDatabaseBackupDto,
    @CurrentUser() user: RequestUser,
  ) {
    try {
      return await this.restoreService.startRestore(id, {
        userId: user.id,
        overrideSchemaCheck: dto.overrideSchemaCheck === true,
      });
    } catch (err) {
      throw toHttpError(err);
    }
  }

  @Post('runs/:id/rollback')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.DB_BACKUP_RESTORE] })
  @ApiParam({ name: 'id', description: 'Database backup run id that was restored' })
  @ApiOperation({
    summary: 'Roll back a completed restore',
    description:
      'In `retain_database` mode (the default) this renames the retained pre-swap database back into place — SECONDS — and exits so the orchestrator restarts against it. In `pre_restore_dump` mode there is no database to rename, so this starts a full restore of the pre-restore safety backup instead (hours). `mode` in the response says which happened; `unavailable` means neither is possible.',
  })
  @ApiResponse({ status: 201, description: '`{ mode, runId, ... }`.' })
  @ApiResponse({
    status: 400,
    description:
      'The run has no completed restore to roll back, the retained database is gone, or the confirmation literal is wrong.',
  })
  @ApiResponse({ status: 404, description: 'Run not found.' })
  async rollback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _dto: RollbackDatabaseRestoreDto,
    @CurrentUser() user: RequestUser,
  ) {
    try {
      return await this.restoreService.rollback(id, { userId: user.id });
    } catch (err) {
      throw toHttpError(err);
    }
  }
}

/**
 * Map the restore service's typed errors onto HTTP.
 *
 * The mapping lives here, not in the service, for the same reason
 * `DatabaseBackupAlreadyRunningError` does (#341/#343): the service is called
 * by more than the HTTP layer, and encoding status codes into it would make a
 * background caller depend on Nest's exception types.
 */
function toHttpError(err: unknown): unknown {
  if (err instanceof DatabaseRestoreNotFoundError) {
    return new NotFoundException(err.message);
  }
  if (err instanceof DatabaseRestoreAlreadyRunningError) {
    // Inside `details`, not at the top level — see the note on
    // `DatabaseBackupAdminService.startRun`: `HttpExceptionFilter` forwards
    // only a fixed set of payload keys, so a top-level `activeRunId` never
    // reaches the client.
    return new ConflictException({
      message: err.message,
      details: { activeRunId: err.activeRunId },
    });
  }
  if (err instanceof DatabaseRestoreNotAllowedError) {
    return new BadRequestException(err.message);
  }
  return err;
}

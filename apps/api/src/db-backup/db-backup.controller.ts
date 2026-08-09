import {
  Body,
  Controller,
  Delete,
  Get,
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
import { UpdateDatabaseBackupConfigDto } from './dto/db-backup-config.dto';
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
 * Restore and rollback (`POST /runs/:id/restore`, `POST /runs/:id/rollback`)
 * are #344's and belong on THIS controller when they land — the routes here are
 * deliberately shaped so that work is an extension, not a second controller.
 */
@ApiTags('Admin - Database Backup')
@Controller('admin/db-backup')
export class DatabaseBackupController {
  constructor(private readonly service: DatabaseBackupAdminService) {}

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
      'A run is already in progress; the body carries the active `runId`.',
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
}

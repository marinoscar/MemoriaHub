// =============================================================================
// NodeBackupController (issue #312, epic #308 — Local Media Backup via Worker Nodes)
// =============================================================================
//
// HTTP surface for the node backup control plane, mounted at
// /api/nodes/:id/backup. Auth mirrors nodes.controller.ts exactly: every
// route requires jobs:write, `nod_` node credentials pass the guard on
// /api/nodes* paths, and owner-scoping (404 unknown node / 403 foreign node)
// is enforced in the service via NodesService.assertOwnership.
// =============================================================================

import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { NodeBackupService } from './node-backup.service';
import {
  BackupAckDto,
  BackupChangesQueryDto,
  BackupManifestQueryDto,
  BackupRunsQueryDto,
  FinishBackupRunDto,
  StartBackupRunDto,
  UpdateBackupConfigDto,
} from './dto/node-backup.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../common/constants/roles.constants';

@ApiTags('Nodes: Backup')
@Controller('nodes/:id/backup')
@Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
export class NodeBackupController {
  constructor(private readonly backupService: NodeBackupService) {}

  // -------------------------------------------------------------------------
  // GET /nodes/:id/backup/config
  // -------------------------------------------------------------------------

  @Get('config')
  @ApiOperation({
    summary: 'Get a node backup configuration with pending lag and active run',
    description:
      'Returns { config: null } when backup has never been configured for the node. ' +
      'Otherwise returns the schedule/scope/checkpoint plus a live pending-lag ' +
      'computation ({ items, bytes }) and the id of the currently-active run (null ' +
      'when none). BigInt byte fields are serialized as strings.',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiResponse({ status: 200, description: '{ config: null | {...} }' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node not found' })
  async getConfig(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.backupService.getConfig(user.id, id);
  }

  // -------------------------------------------------------------------------
  // PUT /nodes/:id/backup/config
  // -------------------------------------------------------------------------

  @Put('config')
  @ApiOperation({
    summary: 'Create or update a node backup configuration (partial upsert)',
    description:
      'Partial body — only the provided keys change. scheduleCron must be a valid ' +
      '5-field cron (null clears the schedule and nextRunAt); timezone must be an ' +
      'IANA name from Intl.supportedValuesOf; every circleIds entry must be a circle ' +
      'the node owner belongs to (empty array = all owner circles). Setting or ' +
      'changing scheduleCron/timezone recomputes nextRunAt in the config timezone ' +
      '(default UTC). Response matches GET.',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiResponse({ status: 200, description: 'Updated config (GET shape)' })
  @ApiResponse({ status: 400, description: 'Invalid cron, timezone, or circleIds' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node not found' })
  async updateConfig(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateBackupConfigDto,
  ) {
    return this.backupService.updateConfig(user.id, id, dto);
  }

  // -------------------------------------------------------------------------
  // POST /nodes/:id/backup/runs
  // -------------------------------------------------------------------------

  @Post('runs')
  @ApiOperation({
    summary: 'Start a backup run (single-active-run rule)',
    description:
      'Creates a running NodeBackupRun whose cursorStart snapshots the current ' +
      'checkpoint. 409 (with activeRunId) when a fresh running run exists; a STALE ' +
      'running run (no ack within backup.runStaleMinutes) is released as `stale` and ' +
      'the new run proceeds. trigger="scheduled" rolls the config nextRunAt forward ' +
      'at start. 400 when backup is unconfigured or disabled.',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiResponse({ status: 201, description: '{ run: { id, kind, startedAt, cursorStart } }' })
  @ApiResponse({ status: 400, description: 'Backup not configured or disabled' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node not found' })
  @ApiResponse({ status: 409, description: 'A run is already active — { message, activeRunId }' })
  async startRun(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: StartBackupRunDto,
  ) {
    return this.backupService.startRun(user.id, id, dto);
  }

  // -------------------------------------------------------------------------
  // GET /nodes/:id/backup/changes
  // -------------------------------------------------------------------------

  @Get('changes')
  @ApiOperation({
    summary: 'Fetch one keyset page of the backup change feed',
    description:
      'Requires runId of the node\'s ACTIVE running run (409 otherwise); the page ' +
      'fetch refreshes the run\'s lastAckAt. Cursor params updatedAfter/afterId are ' +
      'both-or-neither (400 if only one). limit defaults to 100, clamped to ' +
      'backup.maxPageSize. Each item carries a per-page presigned downloadUrl (null ' +
      'for tombstones, not-ready objects, or presign failures) and the full ' +
      'schemaVersion-1 sidecar. nextCursor advances even on a partial page; ' +
      'safetyHorizon is the feed\'s hold-back timestamp.',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiResponse({
    status: 200,
    description: '{ items[], nextCursor|null, hasMore, safetyHorizon }',
  })
  @ApiResponse({ status: 400, description: 'Backup unconfigured or one-sided cursor' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node not found' })
  @ApiResponse({ status: 409, description: 'runId is not the active running run' })
  async getChanges(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query() query: BackupChangesQueryDto,
  ) {
    return this.backupService.getChanges(user.id, id, query);
  }

  // -------------------------------------------------------------------------
  // POST /nodes/:id/backup/ack
  // -------------------------------------------------------------------------

  @Post('ack')
  @ApiOperation({
    summary: 'Acknowledge downloaded pages and advance the checkpoint',
    description:
      'Validates the active run (409 otherwise) and the MONOTONIC checkpoint rule: a ' +
      'cursor strictly behind the stored checkpoint is rejected with 409 (equal is an ' +
      'allowed no-op advance). In one transaction: advances the config checkpoint, ' +
      'increments itemsAcked (downloaded + skipped) and bytesAcked, and accumulates ' +
      'the same stats onto the run\'s counters (errors → errorCount), refreshing ' +
      'lastAckAt and cursorEnd. bytesDownloaded is a decimal string (BigInt-safe).',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiResponse({ status: 201, description: '{ ok: true, checkpoint: { updatedAt, id } }' })
  @ApiResponse({ status: 400, description: 'Backup not configured for this node' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node not found' })
  @ApiResponse({
    status: 409,
    description: 'runId is not the active running run, or the cursor regressed',
  })
  async ack(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: BackupAckDto,
  ) {
    return this.backupService.ack(user.id, id, dto);
  }

  // -------------------------------------------------------------------------
  // POST /nodes/:id/backup/runs/:runId/finish
  // -------------------------------------------------------------------------

  @Post('runs/:runId/finish')
  @ApiOperation({
    summary: 'Finish a backup run (completed / failed / aborted)',
    description:
      'Sets the terminal status + finishedAt (+ lastError from error); accumulates ' +
      'optional finalStats onto the run counters. On completed, stamps the config\'s ' +
      'lastCompletedRunAt (and lastReconcileAt for a reconcile run). 404 for an ' +
      'unknown run or a run of another node; 400 when the run is already terminal.',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiParam({ name: 'runId', description: 'Backup run UUID' })
  @ApiResponse({ status: 201, description: '{ ok: true }' })
  @ApiResponse({ status: 400, description: 'Run already terminal' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node or run not found' })
  async finishRun(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body() dto: FinishBackupRunDto,
  ) {
    return this.backupService.finishRun(user.id, id, runId, dto);
  }

  // -------------------------------------------------------------------------
  // GET /nodes/:id/backup/runs
  // -------------------------------------------------------------------------

  @Get('runs')
  @ApiOperation({
    summary: 'List recent backup runs for a node (newest first)',
    description:
      'Ordered startedAt desc; limit defaults to 20, capped at 100. bytesDownloaded ' +
      'is serialized as a string.',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiResponse({ status: 200, description: '{ runs: [...] }' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node not found' })
  async listRuns(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query() query: BackupRunsQueryDto,
  ) {
    return this.backupService.listRuns(user.id, id, query.limit);
  }

  // -------------------------------------------------------------------------
  // GET /nodes/:id/backup/manifest
  // -------------------------------------------------------------------------

  @Get('manifest')
  @ApiOperation({
    summary: 'Fetch one id-keyset page of the reconcile manifest',
    description:
      'Requires the active running run (409 otherwise; the fetch refreshes ' +
      'lastAckAt). Pages by afterId; limit defaults to 1000 and is hard-capped at ' +
      '1000. Returns { items: [{ id, contentHash, updatedAt, deletedAt, archivedAt }], ' +
      'nextAfterId, hasMore }.',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiResponse({ status: 200, description: '{ items[], nextAfterId|null, hasMore }' })
  @ApiResponse({ status: 400, description: 'Backup not configured for this node' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node not found' })
  @ApiResponse({ status: 409, description: 'runId is not the active running run' })
  async getManifest(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query() query: BackupManifestQueryDto,
  ) {
    return this.backupService.getManifest(user.id, id, query);
  }

  // -------------------------------------------------------------------------
  // GET /nodes/:id/backup/dimensions
  // -------------------------------------------------------------------------

  @Get('dimensions')
  @ApiOperation({
    summary: 'Get the album/person/tag dimension catalogs for the backup scope',
    description:
      'No run required. Scope is the config\'s circleIds (or ALL owner circles when ' +
      'unconfigured). Returns { albums, people, tags, generatedAt }.',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiResponse({ status: 200, description: '{ albums[], people[], tags[], generatedAt }' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node not found' })
  async getDimensions(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.backupService.getDimensions(user.id, id);
  }
}

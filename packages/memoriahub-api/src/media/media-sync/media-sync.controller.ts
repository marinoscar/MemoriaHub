import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  MEMORIAHUB_ERROR_SCHEMA,
  MemoriahubApiDataResponse,
  MemoriahubAuth,
  MemoriahubAuthCredential,
  MemoriahubCurrentUser,
  type MemoriahubRequestUser,
} from '../../core/index.js';
import type { MemoriahubCredential } from '../../ports/index.js';
import { MEDIA_PERMISSIONS as PERMISSIONS } from '../constants/permissions.js';
import {
  CheckinDto,
  CheckinResultDto,
  CommandDto,
  ConfigResultDto,
  DeviceViewDto,
  ListReportsQueryDto,
  ListRunsQueryDto,
  RegisterDeviceDto,
  ReportCreatedViewDto,
  ReportSummaryViewDto,
  ReportViewDto,
  RunViewDto,
  UpdateConfigDto,
  UploadDiagnosticsDto,
} from './media-sync.dto.js';
import { REPORTS_KEPT_PER_DEVICE, RUNS_KEPT_PER_DEVICE } from '@marinoscar/memoriahub-contract/media-sync';
import { MediaSyncService, type MediaSyncCredential } from './media-sync.service.js';

// =============================================================================
// /api/media-sync — the Android Media Sync device API (epic #498, issue #505)
// =============================================================================
//
// Contract: docs/specs/android-media-sync.md §6.2-§6.4. Owner-scoped: another
// user's device is a 404. `media:read` for GET, `media:write` otherwise. The
// phone calls these with its paired PAT; the web with its session JWT. A PAT
// linked to a device may write only that device (§6.2 "PAT scoping").
// Refusals carry `details.reason` (§17.1).
// =============================================================================

const DEVICE_ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The media sync device id.' } as const;
const REPORT_ID_PARAM = { name: 'reportId', type: String, format: 'uuid', description: 'The diagnostics report id.' } as const;

const NOT_FOUND = {
  status: 404,
  description: 'The caller has no device with this id (or a device-linked PAT named another device)',
  schema: MEMORIAHUB_ERROR_SCHEMA,
} as const;
const REVOKED = { status: 409, description: '`details.reason`: `DEVICE_REVOKED`', schema: MEMORIAHUB_ERROR_SCHEMA } as const;

/**
 * The `MediaSyncController` routes; mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Media Sync')
@Controller('media-sync')
export class MediaSyncController {
  constructor(private readonly mediaSync: MediaSyncService) {}

  /** Register a phone. */
  @Post('devices')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({
    summary: 'Register a phone',
    description:
      "Called by the phone with the personal access token the device flow issued it. Upserts on the caller's " +
      '`installationId` and links that token (a previously linked token is revoked in the same transaction; ' +
      'a revoked device comes back active). A new device starts with the default config: the personal circle, ' +
      'no folders (nothing syncs until folders are chosen), Wi-Fi only. 201 for a new device, 200 for a ' +
      're-registration.',
  })
  @MemoriahubApiDataResponse(DeviceViewDto, { status: 201, description: 'A new device' })
  @MemoriahubApiDataResponse(DeviceViewDto, { status: 200, description: 'An existing device, re-registered' })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or `details.reason`: `PAT_REQUIRED` (called with a session token)',
    schema: MEMORIAHUB_ERROR_SCHEMA,
  })
  async register(
    @MemoriahubCurrentUser('id') userId: string,
    @MemoriahubAuthCredential() credential: MemoriahubCredential | null,
    @Body() dto: RegisterDeviceDto,
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ) {
    const { device, created } = await this.mediaSync.register(userId, dto, credential as MediaSyncCredential | null);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return device;
  }

  /** List paired phones. */
  @Get('devices')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'List paired phones',
    description: "The caller's devices, most recently seen first; revoked devices included.",
  })
  @MemoriahubApiDataResponse(DeviceViewDto, { isArray: true })
  list(@MemoriahubCurrentUser('id') userId: string) {
    return this.mediaSync.list(userId);
  }

  /** Get a paired phone. */
  @Get('devices/:id')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Get a paired phone',
    description: 'Status, desired config, reported inventory and counts, and update availability.',
  })
  @ApiParam(DEVICE_ID_PARAM)
  @MemoriahubApiDataResponse(DeviceViewDto)
  @ApiResponse(NOT_FOUND)
  get(@MemoriahubCurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.mediaSync.get(userId, id);
  }

  /** Update a phone's desired config. */
  @Patch('devices/:id/config')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({
    summary: "Update a phone's desired config",
    description:
      'Partial update from the web or from the phone itself. `targetCircleId` needs the collaborator role in ' +
      'that circle; every `folders[].bucketId` must be in the inventory the phone last reported (or in the ' +
      '`inventory` the phone sends with this request; a session token may not send one). Folder names are ' +
      'taken from the inventory. `paused` and the generations change only through commands. Bumps ' +
      '`configVersion` by one; the phone applies it at its next check-in.',
  })
  @ApiParam(DEVICE_ID_PARAM)
  @MemoriahubApiDataResponse(ConfigResultDto)
  @ApiResponse({
    status: 400,
    description:
      'Validation error, or `details.reason`: `UNKNOWN_FOLDER` (with `details.bucketIds`), `INVENTORY_NOT_ALLOWED`',
    schema: MEMORIAHUB_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 403,
    description: 'Missing media:write, or `details.reason`: `TARGET_CIRCLE_FORBIDDEN` (with `details.circleId`)',
    schema: MEMORIAHUB_ERROR_SCHEMA,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REVOKED)
  updateConfig(
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
    @MemoriahubAuthCredential() credential: MemoriahubCredential | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConfigDto,
  ) {
    return this.mediaSync.updateConfig({ id: user.id, permissions: user.permissions }, id, dto, credential as MediaSyncCredential | null);
  }

  /** Send a command to a phone. */
  @Post('devices/:id/commands')
  @HttpCode(HttpStatus.OK)
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({
    summary: 'Send a command to a phone',
    description:
      '`pause` / `resume` set `config.paused`; `retry_failed` / `sync_now` increment their generation. Every ' +
      "command bumps `configVersion`. The phone's own Stop/Start uses this too, so the web reflects it.",
  })
  @ApiParam(DEVICE_ID_PARAM)
  @MemoriahubApiDataResponse(ConfigResultDto)
  @ApiResponse({ status: 400, description: 'Validation error', schema: MEMORIAHUB_ERROR_SCHEMA })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REVOKED)
  command(
    @MemoriahubCurrentUser('id') userId: string,
    @MemoriahubAuthCredential() credential: MemoriahubCredential | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CommandDto,
  ) {
    return this.mediaSync.command(userId, id, dto.action, credential as MediaSyncCredential | null);
  }

  /** Check in from a phone. */
  @Post('devices/:id/checkin')
  @HttpCode(HttpStatus.OK)
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({
    summary: 'Check in from a phone',
    description:
      "Sent with the device's own personal access token. Stores the reported counts, folder inventory, " +
      `permission and network state, and the finished run when present (the newest ${RUNS_KEPT_PER_DEVICE} ` +
      'runs are kept). Returns the desired config the phone must apply.',
  })
  @ApiParam(DEVICE_ID_PARAM)
  @MemoriahubApiDataResponse(CheckinResultDto)
  @ApiResponse({
    status: 400,
    description:
      "Validation error, or `details.reason`: `PAT_REQUIRED` (a session token, or a token that is not the device's)",
    schema: MEMORIAHUB_ERROR_SCHEMA,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(REVOKED)
  checkin(
    @MemoriahubCurrentUser('id') userId: string,
    @MemoriahubAuthCredential() credential: MemoriahubCredential | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CheckinDto,
  ) {
    return this.mediaSync.checkin(userId, id, dto, credential as MediaSyncCredential | null);
  }

  /** List a phone's sync runs. */
  @Get('devices/:id/runs')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: "List a phone's sync runs", description: 'Newest first; `bytesUploaded` is a string.' })
  @ApiParam(DEVICE_ID_PARAM)
  @MemoriahubApiDataResponse(RunViewDto, { isArray: true })
  @ApiResponse(NOT_FOUND)
  listRuns(
    @MemoriahubCurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListRunsQueryDto,
  ) {
    return this.mediaSync.listRuns(userId, id, query.limit);
  }

  /** Upload a diagnostics report. */
  @Post('devices/:id/diagnostics')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({
    summary: 'Upload a diagnostics report',
    description: `Accepted for a revoked device too. The newest ${REPORTS_KEPT_PER_DEVICE} reports per device are kept.`,
  })
  @ApiParam(DEVICE_ID_PARAM)
  @MemoriahubApiDataResponse(ReportCreatedViewDto, { status: 201 })
  @ApiResponse({ status: 400, description: 'Validation error', schema: MEMORIAHUB_ERROR_SCHEMA })
  @ApiResponse(NOT_FOUND)
  uploadDiagnostics(
    @MemoriahubCurrentUser('id') userId: string,
    @MemoriahubAuthCredential() credential: MemoriahubCredential | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadDiagnosticsDto,
  ) {
    return this.mediaSync.uploadDiagnostics(userId, id, dto, credential as MediaSyncCredential | null);
  }

  /** List a phone's diagnostics reports. */
  @Get('devices/:id/diagnostics')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: "List a phone's diagnostics reports", description: 'Newest first, without the report body.' })
  @ApiParam(DEVICE_ID_PARAM)
  @MemoriahubApiDataResponse(ReportSummaryViewDto, { isArray: true })
  @ApiResponse(NOT_FOUND)
  listDiagnostics(
    @MemoriahubCurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListReportsQueryDto,
  ) {
    return this.mediaSync.listDiagnostics(userId, id, query.limit);
  }

  /** Get a diagnostics report. */
  @Get('devices/:id/diagnostics/:reportId')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get a diagnostics report', description: 'The full report body.' })
  @ApiParam(DEVICE_ID_PARAM)
  @ApiParam(REPORT_ID_PARAM)
  @MemoriahubApiDataResponse(ReportViewDto)
  @ApiResponse({ status: 404, description: 'No such device or report for the caller', schema: MEMORIAHUB_ERROR_SCHEMA })
  getDiagnostics(
    @MemoriahubCurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ) {
    return this.mediaSync.getDiagnostics(userId, id, reportId);
  }

  /** Unpair a phone. */
  @Delete('devices/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({
    summary: 'Unpair a phone',
    description:
      'The device becomes `revoked` and its linked access token is revoked in the same transaction. Uploaded ' +
      'media stays. Idempotent.',
  })
  @ApiParam(DEVICE_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Unpaired' })
  @ApiResponse(NOT_FOUND)
  async unpair(
    @MemoriahubCurrentUser('id') userId: string,
    @MemoriahubAuthCredential() credential: MemoriahubCredential | null,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.mediaSync.unpair(userId, id, credential as MediaSyncCredential | null);
  }
}

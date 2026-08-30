import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MediaEnhancementStatus } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { MediaEnhancementService } from './media-enhancement.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { EnhanceParamsDto } from './dto/enhance-params.dto';
import { BulkEnhanceDto } from './dto/bulk-enhance.dto';
import { ApplyEnhancementDto } from './dto/apply-enhancement.dto';
import {
  ENHANCEMENT_STATUS_ALIASES,
  ListEnhancementsQueryDto,
} from './dto/list-enhancements-query.dto';

@ApiTags('Picture Enhancement')
@ApiBearerAuth('JWT-auth')
@Controller('media')
export class MediaEnhancementController {
  constructor(private readonly service: MediaEnhancementService) {}

  // ===========================================================================
  // Static routes
  //
  // Declared BEFORE any @Get(':id')-style route so a literal path segment is
  // never captured as an :id param. This controller is mounted on the same
  // 'media' prefix as MediaController, whose @Get(':id') would otherwise
  // shadow /media/enhancements — same convention (and same reason) as the
  // static-route block in media.controller.ts.
  //
  // This applies to EVERY literal-prefixed route here, not just GET routes:
  // POST 'bulk/enhance' must also live in this block, or 'bulk' is captured as
  // the :id param of a later-registered parameterised route.
  // ===========================================================================

  /**
   * GET /api/media/enhancements — cross-item listing for the Enhancements hub.
   * Declared in the static-routes block so it is never shadowed by @Get(':id').
   */
  @Get('enhancements')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: "List a circle's AI enhancements (paginated)",
    description:
      'Cross-item listing of every AI picture enhancement in the circle — the data behind ' +
      'the AI Enhancements hub. Byte sizes are returned as STRINGS (the underlying columns ' +
      'are 64-bit and not JSON-safe as numbers). `original.thumbnailUrl` is the source ' +
      "item's signed thumbnail; `enhanced.thumbnailUrl` is a signed URL to the staged " +
      'full-resolution bytes (staged objects have no thumbnail derivative) and is non-null ' +
      'only while the row is `ready`. `expiresAt` is computed server-side from `updatedAt` ' +
      'plus `pictureEnhancement.retentionHours` and is non-null only for the `ready` and ' +
      '`failed` statuses — the two the retention purge job reaps.',
  })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid', description: 'Circle to list enhancements for' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [
      ...Object.values(MediaEnhancementStatus),
      ...Object.keys(ENHANCEMENT_STATUS_ALIASES),
    ],
    description:
      'Filter by a concrete status, or by one of three convenience aliases: ' +
      '`in_progress` (pending, processing), `awaiting_decision` (ready), ' +
      '`terminal` (applied, discarded, expired).',
  })
  @ApiQuery({
    name: 'batchId',
    required: false,
    type: String,
    format: 'uuid',
    description:
      'Narrow to one bulk-enhance batch (see GET /api/enhancement-batches). Composes with `status`.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Default 1' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Default 24, max 50' })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['createdAt', 'updatedAt'], description: 'Default createdAt' })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'], description: 'Default desc' })
  @ApiResponse({ status: 200, description: 'Paginated enhancement list with { items, meta }' })
  @ApiResponse({ status: 400, description: 'Invalid query params' })
  @ApiResponse({ status: 403, description: 'Caller is not a viewer of the circle' })
  async list(
    @Query() query: ListEnhancementsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listEnhancements(query, user);
  }

  /**
   * POST /api/media/bulk/enhance — queue an enhancement per eligible item in a
   * selection. Declared in the static-routes block so `bulk` is never captured
   * as an :id param.
   */
  @Post('bulk/enhance')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Queue AI enhancements for a selection of photos (bulk)',
    description:
      'Creates a batch and queues one enhancement per ELIGIBLE item. Unlike the single-item ' +
      'endpoint, an ineligible item never fails the request: non-photos, oversized images, ' +
      'and items that already have a live (pending/processing/ready) enhancement are skipped ' +
      'and reported per-reason in `skipped`. In particular an existing `ready` result is NEVER ' +
      'superseded — it is a completed, already-billed render awaiting a human decision. ' +
      'The batch row is created even when nothing is eligible (`queued: 0`), so the caller ' +
      'always gets a pollable batch id explaining the outcome. Distinct ids are counted ' +
      'against the `pictureEnhancement.maxBatchSize` limit (also surfaced on GET /api/features).',
  })
  @ApiResponse({
    status: 202,
    description:
      'Batch created: { batchId, requested, queued, skipped: { notPhoto, tooLarge, alreadyLive } }',
  })
  @ApiResponse({
    status: 400,
    description: 'Feature disabled / no model configured / selection exceeds maxBatchSize',
  })
  @ApiResponse({ status: 403, description: 'Caller is not a collaborator of the circle' })
  @ApiResponse({ status: 404, description: 'One or more ids are not live items of the circle' })
  async startBatch(@Body() dto: BulkEnhanceDto, @CurrentUser() user: RequestUser) {
    return this.service.startBatch(dto, user);
  }

  // ===========================================================================
  // Parameterised (:id) routes
  // ===========================================================================

  /**
   * POST /api/media/:id/enhance — start an AI enhancement.
   */
  @Post(':id/enhance')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Start an AI picture enhancement for a photo' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 202, description: 'Enhancement enqueued' })
  @ApiResponse({ status: 400, description: 'Feature disabled / not a photo / no model' })
  @ApiResponse({ status: 404, description: 'Media item not found' })
  async start(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EnhanceParamsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.startEnhance(id, dto, user);
  }

  /**
   * GET /api/media/:id/enhance — latest enhancement for the item (resume UI).
   */
  @Get(':id/enhance')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get the latest enhancement for a media item' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Latest enhancement (or null)' })
  async latest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getLatestEnhancement(id, user);
  }

  /**
   * GET /api/media/:id/enhance/:enhancementId — poll status + compare payload.
   */
  @Get(':id/enhance/:enhancementId')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get an enhancement status and compare payload' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'enhancementId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Enhancement status' })
  @ApiResponse({ status: 404, description: 'Enhancement not found' })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('enhancementId', ParseUUIDPipe) enhancementId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getEnhancement(id, enhancementId, user);
  }

  /**
   * POST /api/media/:id/enhance/:enhancementId/apply — keep_both | replace.
   */
  @Post(':id/enhance/:enhancementId/apply')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Apply an enhancement (keep_both or replace)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'enhancementId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Replace applied' })
  @ApiResponse({ status: 201, description: 'New enhanced item created (keep_both)' })
  @ApiResponse({ status: 400, description: 'Not ready / replace disabled / downscale blocked' })
  async apply(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('enhancementId', ParseUUIDPipe) enhancementId: string,
    @Body() dto: ApplyEnhancementDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const result = await this.service.applyEnhancement(id, enhancementId, dto.decision, user, {
      acknowledgeDownscale: dto.acknowledgeDownscale === true,
    });
    res.status(dto.decision === 'keep_both' ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }

  /**
   * POST /api/media/:id/enhance/:enhancementId/discard — drop the staging bytes.
   */
  @Post(':id/enhance/:enhancementId/discard')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Discard an enhancement preview' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'enhancementId', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Enhancement discarded' })
  async discard(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('enhancementId', ParseUUIDPipe) enhancementId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.service.discardEnhancement(id, enhancementId, user);
  }
}

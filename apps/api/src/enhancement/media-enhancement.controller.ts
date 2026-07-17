import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { MediaEnhancementService } from './media-enhancement.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { EnhanceParamsDto } from './dto/enhance-params.dto';
import { ApplyEnhancementDto } from './dto/apply-enhancement.dto';

@ApiTags('Picture Enhancement')
@ApiBearerAuth()
@Controller('media')
export class MediaEnhancementController {
  constructor(private readonly service: MediaEnhancementService) {}

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
    const result = await this.service.applyEnhancement(id, enhancementId, dto.decision, user);
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

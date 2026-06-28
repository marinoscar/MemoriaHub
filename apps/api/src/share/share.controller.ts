import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ShareTargetType } from '@prisma/client';

import { ShareService, ListSharesQuery, ShareStatus } from './share.service';
import { CreateShareDto } from './dto/create-share.dto';
import { UpdateShareDto } from './dto/update-share.dto';
import { BulkShareDto } from './dto/bulk-share.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

@ApiTags('Sharing')
@Controller('shares')
export class ShareController {
  constructor(private readonly shareService: ShareService) {}

  /**
   * POST /api/shares
   * Create a new share for a MediaItem or Album.
   * Idempotent: returns the existing active share if one exists.
   */
  @Post()
  @Auth({ permissions: [PERMISSIONS.SHARES_MANAGE] })
  @ApiOperation({ summary: 'Create a share link for a media item or album' })
  @ApiResponse({ status: 201, description: 'Share created or existing active share returned' })
  async create(
    @Body() dto: CreateShareDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.shareService.createShare(user.id, user.permissions, dto);
  }

  /**
   * GET /api/shares
   * List shares. scope=mine (default) or scope=all (requires shares:manage_any).
   */
  @Get()
  @Auth({ permissions: [PERMISSIONS.SHARES_MANAGE] })
  @ApiOperation({ summary: 'List shares (own by default; scope=all requires shares:manage_any)' })
  @ApiQuery({ name: 'scope', required: false, enum: ['mine', 'all'] })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'expired', 'revoked'] })
  @ApiQuery({ name: 'targetType', required: false, enum: ShareTargetType })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated list of shares with previews' })
  async list(
    @Query('scope') scope: 'mine' | 'all' | undefined,
    @Query('status') status: ShareStatus | undefined,
    @Query('targetType') targetType: ShareTargetType | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    const query: ListSharesQuery = {
      scope,
      status,
      targetType,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    };
    return this.shareService.listShares(user.id, user.permissions, query);
  }

  /**
   * PATCH /api/shares/:id
   * Update a share's expiration. Caller must own the share or have shares:manage_any.
   */
  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.SHARES_MANAGE] })
  @ApiOperation({ summary: 'Update share expiration' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Share updated' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateShareDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.shareService.updateShare(user.id, user.permissions, id, dto);
  }

  /**
   * DELETE /api/shares/:id
   * Revoke a share (soft; sets revokedAt). Idempotent.
   */
  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.SHARES_MANAGE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a share' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Share revoked' })
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.shareService.revokeShare(user.id, user.permissions, id);
  }

  /**
   * POST /api/shares/bulk
   * Bulk revoke, update expiration, or hard-delete a set of shares.
   */
  @Post('bulk')
  @Auth({ permissions: [PERMISSIONS.SHARES_MANAGE] })
  @ApiOperation({ summary: 'Bulk action on shares (revoke, set_expiration, delete)' })
  @ApiResponse({ status: 200, description: 'Bulk action result' })
  async bulk(
    @Body() dto: BulkShareDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.shareService.bulkAction(user.id, user.permissions, dto);
  }
}

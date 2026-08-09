// =============================================================================
// Memories — HTTP surface (epic #300, issue #307)
// =============================================================================
//
// RBAC, in one place (see docs/specs/memories.md §10):
//
//   - Reads and per-user state  : `media:read`  + per-circle **viewer**
//   - Delete and save-as-album  : `media:write` + per-circle **collaborator**
//
// NO new permission was introduced. A memory is a derived view over media the
// caller can already see, so `media:read`/`media:write` plus the per-circle
// roles express the intent exactly — the same decision Workflows made, and the
// epic's stated tie-breaker.
//
// Per-user state (`seen`/`hide`/`favorite`) is scoped to the JWT's `userId` and
// touches no circle content, so it needs membership only; it still carries
// `media:read` because that is the permission the whole surface is gated on and
// a caller without it has no business reading the memory it refers to.
//
// EVERY `:id` route resolves through `MemoriesService.loadAccessibleMemory`,
// which returns **404 (not 403)** for a memory in a circle the caller is not a
// member of — enumeration-resistant, matching the notifications `:id` policy.
//
// The static `/feed` route is declared BEFORE `:id` so it is not shadowed.
// =============================================================================

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { MemoryFeedQueryDto, MemoryListQueryDto } from './dto/memory-query.dto';
import {
  MemoryDetailDto,
  MemoryFeedDto,
  MemoryListDto,
  SaveMemoryAlbumResultDto,
} from './dto/memory-response.dto';
import { SaveMemoryAlbumDto } from './dto/save-memory-album.dto';
import { MemoriesService } from './memories.service';

@ApiTags('Memories')
@ApiBearerAuth('JWT-auth')
@Controller('memories')
export class MemoriesController {
  constructor(private readonly memoriesService: MemoriesService) {}

  // ---------------------------------------------------------------------------
  // GET /api/memories
  // ---------------------------------------------------------------------------

  @Get()
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: "Browse a circle's memories (keyset paginated, newest first)",
    description:
      'Excludes deleted (tombstoned) memories, expired memories, memories the ' +
      'caller has hidden, and memories filtered by the caller\'s ' +
      '`user_settings.memories` preferences. Returns an EMPTY page — never an ' +
      'error — when `features.memories` is off.',
  })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid' })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: [
      'on_this_day',
      'trip',
      'person_highlights',
      'person_over_years',
      'theme',
      'seasonal',
      'year_in_review',
    ],
  })
  @ApiQuery({
    name: 'year',
    required: false,
    type: Number,
    description: 'Keeps memories whose covered period overlaps that UTC year.',
  })
  @ApiQuery({
    name: 'favorite',
    required: false,
    type: Boolean,
    description: "`true` narrows to the caller's own favorites.",
  })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Max 100.' })
  @ApiResponse({ status: 200, description: 'Keyset page of memory cards', type: MemoryListDto })
  async list(
    @Query() query: MemoryListQueryDto,
    @CurrentUser() user: RequestUser,
  ): Promise<MemoryListDto> {
    return this.memoriesService.list(query, user.id, user.permissions);
  }

  // ---------------------------------------------------------------------------
  // GET /api/memories/feed   (before :id — static routes must not be shadowed)
  // ---------------------------------------------------------------------------

  @Get('feed')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Home carousel feed (max 10 cards)',
    description:
      "Ordered: today's On This Day memories (closest year first), then the " +
      'newest unseen, then the newest seen. Each card carries up to four item ' +
      'thumbnails for the fan effect. Empty when `features.memories` is off.',
  })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Feed cards', type: MemoryFeedDto })
  async feed(
    @Query() query: MemoryFeedQueryDto,
    @CurrentUser() user: RequestUser,
  ): Promise<MemoryFeedDto> {
    return this.memoriesService.feed(query, user.id, user.permissions);
  }

  // ---------------------------------------------------------------------------
  // GET /api/memories/:id
  // ---------------------------------------------------------------------------

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Full memory detail with its ordered items',
    description:
      'Preference filters are intentionally NOT applied here so a direct link ' +
      'always resolves; hide and delete are the tools on this page. A memory ' +
      'in a circle the caller does not belong to returns 404, not 403.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Memory detail', type: MemoryDetailDto })
  @ApiResponse({ status: 404, description: 'Not found, deleted, expired, or not accessible' })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<MemoryDetailDto> {
    return this.memoriesService.detail(id, user.id, user.permissions);
  }

  // ---------------------------------------------------------------------------
  // Per-user state — membership only, scoped to the JWT user
  // ---------------------------------------------------------------------------

  @Post(':id/seen')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark a memory seen by the current user',
    description:
      'Idempotent: `seenAt` is preserved once set, so it always names the ' +
      'FIRST view (same contract as marking a notification read).',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Marked seen' })
  async markSeen(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.memoriesService.markSeen(id, user.id, user.permissions);
  }

  @Post(':id/hide')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Hide a memory for the current user only',
    description:
      'Personal and reversible — it does NOT delete the memory and does not ' +
      'affect any other circle member. Use DELETE /api/memories/:id for that.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Hidden' })
  async hide(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.memoriesService.hide(id, user.id, user.permissions);
  }

  @Delete(':id/hide')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Un-hide a memory for the current user' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Un-hidden' })
  async unhide(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.memoriesService.unhide(id, user.id, user.permissions);
  }

  @Post(':id/favorite')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Favorite a memory for the current user' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Favorited' })
  async favorite(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.memoriesService.favorite(id, user.id, user.permissions);
  }

  @Delete(':id/favorite')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Un-favorite a memory for the current user' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Un-favorited' })
  async unfavorite(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.memoriesService.unfavorite(id, user.id, user.permissions);
  }

  // ---------------------------------------------------------------------------
  // POST /api/memories/:id/save-album
  // ---------------------------------------------------------------------------

  @Post(':id/save-album')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Save a memory's items as a new album",
    description:
      "Creates an album (default name = the memory's title) containing the " +
      "memory's live items in position order, with the memory's cover as the " +
      'album cover. Deliberately NOT idempotent — saving twice yields two ' +
      'albums. Requires media:write + the collaborator circle role.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Album created', type: SaveMemoryAlbumResultDto })
  async saveAsAlbum(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveMemoryAlbumDto,
    @CurrentUser() user: RequestUser,
  ): Promise<SaveMemoryAlbumResultDto> {
    return this.memoriesService.saveAsAlbum(id, dto, user.id, user.permissions);
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/memories/:id — circle-level tombstone
  // ---------------------------------------------------------------------------

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a memory for the whole circle (tombstone)',
    description:
      'Sets `deletedAt`. The memory disappears for every member and can never ' +
      'be regenerated — the natural-key unique index spans tombstoned rows, so ' +
      'curation recognises and skips it. Writes a `memory:deleted` audit event. ' +
      'Requires media:write + the collaborator circle role.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 403, description: 'Member without the collaborator role' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.memoriesService.remove(id, user.id, user.permissions);
  }
}

import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Res,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { FastifyReply } from 'fastify';

import { MediaService } from './media.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateMediaDto } from './dto/create-media.dto';
import { UpdateMediaDto } from './dto/update-media.dto';
import { MediaQueryDto } from './dto/media-query.dto';
import { AttachTagsDto } from './dto/attach-tags.dto';
import { CreateAlbumDto } from './dto/create-album.dto';
import { UpdateAlbumDto } from './dto/update-album.dto';
import { AlbumQueryDto } from './dto/album-query.dto';
import { AddAlbumItemsDto } from './dto/add-album-items.dto';
import { ExportQueryDto } from './dto/export-query.dto';
import { MediaLocationsQueryDto } from './dto/media-locations-query.dto';
import { BulkUpdateMediaDto } from './dto/bulk-update-media.dto';
import { BulkTagsDto } from './dto/bulk-tags.dto';
import { BulkDeleteDto } from './dto/bulk-delete.dto';

@ApiTags('Media')
@ApiBearerAuth('JWT-auth')
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  // ---------------------------------------------------------------------------
  // Static sub-routes MUST come before /:id to avoid route shadowing
  // ---------------------------------------------------------------------------

  /**
   * GET /api/media/tags
   */
  @Get('tags')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: "List caller's tags with attach counts" })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Tag list returned' })
  async listTags(
    @Query('circleId') circleId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.listTags(circleId, user.id, user.permissions);
  }

  /**
   * GET /api/media/albums
   */
  @Get('albums')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List caller\'s albums (paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['name', 'createdAt', 'updatedAt'] })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  @ApiResponse({ status: 200, description: 'Paginated album list' })
  async listAlbums(
    @Query() query: AlbumQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.listAlbums(query, user.id, user.permissions);
  }

  /**
   * GET /api/media/export
   *
   * Streams a metadata export for the caller's media items.
   * Declared before @Get(':id') to prevent route shadowing.
   */
  @Get('export')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Stream metadata export for the caller\'s media items',
    description:
      'Returns a streaming download of MediaItem metadata in JSON (NDJSON) or CSV format. ' +
      'All records for the specified circle are included. ' +
      'The response is chunked — no size limit for the caller\'s own data.',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'], description: 'Export format (default: json)' })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid', description: 'Circle ID to export media from' })
  @ApiQuery({ name: 'type', required: false, enum: ['photo', 'video'], description: 'Filter by media type' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO 8601 datetime — filter capturedAt >= from' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO 8601 datetime — filter capturedAt <= to' })
  @ApiResponse({ status: 200, description: 'Streaming export — Content-Type is application/json or text/csv' })
  @ApiResponse({ status: 403, description: 'Non-admin caller supplied ownerId for another user' })
  async exportMedia(
    @Query() dto: ExportQueryDto,
    @CurrentUser() user: RequestUser,
    @Res() res: FastifyReply,
  ): Promise<void> {
    // Delegate to service; all validation and header-writing happen there.
    // Errors thrown before streaming begins propagate through Nest's exception filter.
    await this.mediaService.streamExport(dto, user.id, user.permissions, res);
  }

  /**
   * GET /api/media/locations
   *
   * Returns ALL geotagged (takenLat + takenLng) non-deleted media items for the
   * caller as a flat array — no pagination. Intended for the map view.
   * Declared in the static-routes block so it is never shadowed by @Get(':id').
   */
  @Get('locations')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: "List all caller's geotagged media for map view (no pagination)",
    description:
      'Returns every non-deleted media item that has GPS coordinates (takenLat + takenLng). ' +
      'Admins with media:read_any see all users\' items. ' +
      'Optional filters narrow the result by type, date range, and/or geographic metadata.',
  })
  @ApiQuery({ name: 'type', required: false, enum: ['photo', 'video'], description: 'Filter by media type' })
  @ApiQuery({ name: 'capturedAtFrom', required: false, type: String, description: 'ISO 8601 datetime — filter capturedAt >= from' })
  @ApiQuery({ name: 'capturedAtTo', required: false, type: String, description: 'ISO 8601 datetime — filter capturedAt <= to' })
  @ApiQuery({ name: 'country', required: false, type: String, description: 'Matches geoCountry (contains) or geoCountryCode (exact), case-insensitive' })
  @ApiQuery({ name: 'region', required: false, type: String, description: 'Matches geoAdmin1 (contains), case-insensitive' })
  @ApiQuery({ name: 'locality', required: false, type: String, description: 'Matches geoLocality (contains), case-insensitive' })
  @ApiQuery({ name: 'place', required: false, type: String, description: 'Substring match on geoPlaceName, case-insensitive' })
  @ApiQuery({ name: 'location', required: false, type: String, description: 'Free-text search across all geo tiers' })
  @ApiResponse({ status: 200, description: 'Array of geotagged media location objects' })
  async listLocations(
    @Query() query: MediaLocationsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.listLocations(query, user.id, user.permissions);
  }

  /**
   * PATCH /api/media/bulk
   * Bulk update location, classification, or favorite on a set of media items.
   */
  @Patch('bulk')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Bulk update media items (location, classification, favorite)' })
  @ApiResponse({ status: 200, description: 'Items updated' })
  async bulkUpdateMedia(
    @Body() dto: BulkUpdateMediaDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.bulkUpdateMedia(dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/bulk/tags
   * Add and/or remove tags on multiple media items.
   */
  @Post('bulk/tags')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Bulk add/remove tags on media items' })
  @ApiResponse({ status: 200, description: 'Tags updated' })
  async bulkTags(
    @Body() dto: BulkTagsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.bulkTags(dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/bulk/delete
   * Soft-delete multiple media items.
   */
  @Post('bulk/delete')
  @Auth({ permissions: [PERMISSIONS.MEDIA_DELETE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk soft-delete media items' })
  @ApiResponse({ status: 200, description: 'Items soft-deleted' })
  async bulkDelete(
    @Body() dto: BulkDeleteDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.bulkDelete(dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/albums
   */
  @Post('albums')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Create a new album' })
  @ApiResponse({ status: 201, description: 'Album created' })
  async createAlbum(
    @Body() dto: CreateAlbumDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.createAlbum(dto, user.id, user.permissions);
  }

  /**
   * GET /api/media/albums/:id
   */
  @Get('albums/:id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get album with item list' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Album returned' })
  @ApiResponse({ status: 404, description: 'Album not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async getAlbum(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.getAlbum(id, user.id, user.permissions);
  }

  /**
   * PATCH /api/media/albums/:id
   */
  @Patch('albums/:id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Rename / update album' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Album updated' })
  @ApiResponse({ status: 404, description: 'Album not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async updateAlbum(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAlbumDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.updateAlbum(id, dto, user.id, user.permissions);
  }

  /**
   * DELETE /api/media/albums/:id
   */
  @Delete('albums/:id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_DELETE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete album (does not delete MediaItems)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Album deleted' })
  @ApiResponse({ status: 404, description: 'Album not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async deleteAlbum(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.mediaService.deleteAlbum(id, user.id, user.permissions);
  }

  /**
   * POST /api/media/albums/:id/items
   */
  @Post('albums/:id/items')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Add MediaItem(s) to album' })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'Album ID' })
  @ApiResponse({ status: 201, description: 'Items added to album' })
  @ApiResponse({ status: 404, description: 'Album or MediaItem not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async addAlbumItems(
    @Param('id', ParseUUIDPipe) albumId: string,
    @Body() dto: AddAlbumItemsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.addAlbumItems(albumId, dto, user.id, user.permissions);
  }

  /**
   * DELETE /api/media/albums/:id/items/:itemId
   */
  @Delete('albums/:id/items/:itemId')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove MediaItem from album' })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'Album ID' })
  @ApiParam({ name: 'itemId', type: String, format: 'uuid', description: 'AlbumItem ID (the MediaItem ID)' })
  @ApiResponse({ status: 204, description: 'Item removed from album' })
  @ApiResponse({ status: 404, description: 'Album or item not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async removeAlbumItem(
    @Param('id', ParseUUIDPipe) albumId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.mediaService.removeAlbumItem(albumId, itemId, user.id, user.permissions);
  }

  // ---------------------------------------------------------------------------
  // MediaItem routes
  // ---------------------------------------------------------------------------

  /**
   * POST /api/media
   *
   * Deduplication behaviour:
   *   If `contentHash` is supplied in the request body the server checks whether
   *   the caller already owns an active MediaItem with the same hash.  If so,
   *   the redundant StorageObject is cleaned up and the EXISTING MediaItem is
   *   returned with HTTP 200 and `{ deduplicated: true }`.  A fresh create
   *   returns HTTP 201 with `{ deduplicated: false }`.
   *
   *   The same dedup logic fires at the DB level via a partial unique index on
   *   (owner_id, content_hash) as a server-side backstop, even when the client
   *   does not supply a hash.
   */
  @Post()
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({
    summary: 'Register an uploaded StorageObject as a MediaItem',
    description:
      'The referenced StorageObject must be owned by the caller. ' +
      'Returns the created (or existing deduplicated) MediaItem record. ' +
      'When `contentHash` is provided the server deduplicates by (ownerId, contentHash): ' +
      'if an active item with that hash already exists the existing item is returned ' +
      'with HTTP 200 and `deduplicated: true`. A fresh create returns HTTP 201 with ' +
      '`deduplicated: false`. The redundant StorageObject blob is cleaned up best-effort.',
  })
  @ApiResponse({ status: 201, description: 'MediaItem created (fresh)' })
  @ApiResponse({
    status: 200,
    description:
      'Duplicate detected — existing MediaItem returned (deduplicated: true). ' +
      'The redundant StorageObject has been cleaned up best-effort.',
  })
  @ApiResponse({ status: 400, description: 'StorageObject already linked' })
  @ApiResponse({ status: 403, description: 'Caller does not own the StorageObject' })
  @ApiResponse({ status: 404, description: 'StorageObject not found' })
  async createMedia(
    @Body() dto: CreateMediaDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const result = await this.mediaService.createMedia(dto, user.id, user.permissions);
    // Signal dedup vs. fresh create via HTTP status while keeping the body shape
    // consistent so downstream consumers can also inspect `deduplicated`.
    if (result.deduplicated) {
      res.status(HttpStatus.OK);
    } else {
      res.status(HttpStatus.CREATED);
    }
    return result;
  }

  /**
   * GET /api/media
   */
  @Get()
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'List media items (paginated, filtered)',
    description: 'Returns the caller\'s active (non-deleted) media items. Admins with media:read_any see all.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'type', required: false, enum: ['photo', 'video'] })
  @ApiQuery({ name: 'capturedAtFrom', required: false, type: String, description: 'ISO 8601 date' })
  @ApiQuery({ name: 'capturedAtTo', required: false, type: String, description: 'ISO 8601 date' })
  @ApiQuery({ name: 'classification', required: false, enum: ['memory', 'low_value', 'unreviewed'] })
  @ApiQuery({ name: 'albumId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'favorite', required: false, type: Boolean })
  @ApiQuery({ name: 'tag', required: false, type: String, description: 'Exact tag name (case-insensitive)' })
  @ApiQuery({ name: 'country', required: false, type: String, description: 'Matches geoCountry (contains) or geoCountryCode (exact), case-insensitive' })
  @ApiQuery({ name: 'region', required: false, type: String, description: 'Matches geoAdmin1 (contains), case-insensitive' })
  @ApiQuery({ name: 'locality', required: false, type: String, description: 'Matches geoLocality (contains), case-insensitive' })
  @ApiQuery({ name: 'place', required: false, type: String, description: 'Substring match on geoPlaceName, case-insensitive' })
  @ApiQuery({ name: 'location', required: false, type: String, description: 'Free-text search across all geo tiers' })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['capturedAt', 'importedAt', 'createdAt'] })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'cameraMake', required: false, type: String, description: 'Camera make (contains, case-insensitive)' })
  @ApiQuery({ name: 'cameraModel', required: false, type: String, description: 'Camera model (contains, case-insensitive)' })
  @ApiQuery({ name: 'sourceDeviceId', required: false, type: String, description: 'Exact source device ID' })
  @ApiQuery({ name: 'sourceDeviceName', required: false, type: String, description: 'Source device name (contains, case-insensitive)' })
  @ApiQuery({ name: 'missingGeo', required: false, type: Boolean, description: 'true = missing GPS, false = has GPS' })
  @ApiResponse({ status: 200, description: 'Paginated media list' })
  async listMedia(
    @Query() query: MediaQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.listMedia(query, user.id, user.permissions);
  }

  /**
   * GET /api/media/:id
   */
  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get a single MediaItem' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'MediaItem returned' })
  @ApiResponse({ status: 404, description: 'MediaItem not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async getMedia(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.getMedia(id, user.id, user.permissions);
  }

  /**
   * PATCH /api/media/:id
   */
  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({
    summary: 'Update mutable fields on a MediaItem',
    description: 'Mutable: capturedAt, capturedAtOffset, classification, metadata, title, caption, description, favorite.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'MediaItem updated' })
  @ApiResponse({ status: 404, description: 'MediaItem not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async updateMedia(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMediaDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.updateMedia(id, dto, user.id, user.permissions);
  }

  /**
   * DELETE /api/media/:id  — soft-delete
   */
  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_DELETE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Soft-delete a MediaItem',
    description: 'Sets deletedAt timestamp. The underlying StorageObject and blob are NOT removed.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'MediaItem soft-deleted' })
  @ApiResponse({ status: 404, description: 'MediaItem not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async deleteMedia(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.mediaService.deleteMedia(id, user.id, user.permissions);
  }

  /**
   * POST /api/media/:id/tags
   */
  @Post(':id/tags')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({
    summary: 'Attach one or more tags to a MediaItem',
    description: 'Creates Tag records if they do not exist (idempotent on name). Returns the attached tags.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Tags attached' })
  @ApiResponse({ status: 404, description: 'MediaItem not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async attachTags(
    @Param('id', ParseUUIDPipe) mediaItemId: string,
    @Body() dto: AttachTagsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.attachTags(mediaItemId, dto, user.id, user.permissions);
  }

  /**
   * DELETE /api/media/:id/tags/:tagId
   */
  @Delete(':id/tags/:tagId')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a tag from a MediaItem' })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'MediaItem ID' })
  @ApiParam({ name: 'tagId', type: String, format: 'uuid', description: 'Tag ID' })
  @ApiResponse({ status: 204, description: 'Tag removed' })
  @ApiResponse({ status: 404, description: 'Tag not attached to this MediaItem' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async removeTag(
    @Param('id', ParseUUIDPipe) mediaItemId: string,
    @Param('tagId', ParseUUIDPipe) tagId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.mediaService.removeTag(mediaItemId, tagId, user.id, user.permissions);
  }
}

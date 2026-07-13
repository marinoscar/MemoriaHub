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
import { AddAlbumItemsByFilterDto } from './dto/add-album-items-by-filter.dto';
import { ExportQueryDto } from './dto/export-query.dto';
import { MediaLocationsQueryDto } from './dto/media-locations-query.dto';
import { MediaLocationsAggregateQueryDto } from './dto/media-locations-aggregate-query.dto';
import { BulkUpdateMediaDto } from './dto/bulk-update-media.dto';
import { BulkTagsDto } from './dto/bulk-tags.dto';
import { BulkDeleteDto } from './dto/bulk-delete.dto';
import { BulkArchiveDto } from './dto/bulk-archive.dto';
import { ListArchivedQueryDto } from './dto/list-archived-query.dto';
import { ListTrashQueryDto } from './dto/list-trash-query.dto';
import { RestoreFromTrashDto } from './dto/restore-from-trash.dto';
import { DeleteForeverDto } from './dto/delete-forever.dto';
import { EmptyTrashDto } from './dto/empty-trash.dto';
import { ReverseGeocodeQueryDto } from './dto/reverse-geocode-query.dto';
import { GeoSearchQueryDto } from './dto/geo-search-query.dto';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

@ApiTags('Media')
@ApiBearerAuth('JWT-auth')
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  // ---------------------------------------------------------------------------
  // Static sub-routes MUST come before /:id to avoid route shadowing
  // ---------------------------------------------------------------------------

  /**
   * GET /api/media/explore/places
   */
  @Get('explore/places')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Explore: places with media counts and cover thumbnail' })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Array of places ordered by item count desc (max 50)',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
          coverThumbnailUrl: { type: 'string', nullable: true },
        },
      },
    },
  })
  async explorePlaces(
    @Query('circleId') circleId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.explorePlaces(circleId, user.id, user.permissions);
  }

  /**
   * GET /api/media/explore/tags
   */
  @Get('explore/tags')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Explore: tags with media counts and cover thumbnail' })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Array of tags ordered by item count desc (max 50)',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
          coverThumbnailUrl: { type: 'string', nullable: true },
        },
      },
    },
  })
  async exploreTags(
    @Query('circleId') circleId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.exploreTags(circleId, user.id, user.permissions);
  }

  /**
   * GET /api/media/explore/locations
   */
  @Get('explore/locations')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Explore: tiered locations (top countries, regions, cities) with counts and cover thumbnails',
  })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Top 12 countries, regions, and cities by item count, each with a cover thumbnail',
    schema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              countryCode: { type: 'string', nullable: true },
              count: { type: 'number' },
              coverThumbnailUrl: { type: 'string', nullable: true },
            },
          },
        },
        regions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              count: { type: 'number' },
              coverThumbnailUrl: { type: 'string', nullable: true },
            },
          },
        },
        cities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              count: { type: 'number' },
              coverThumbnailUrl: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
  })
  async exploreLocations(
    @Query('circleId') circleId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.exploreLocations(circleId, user.id, user.permissions);
  }

  /**
   * GET /api/media/explore/locations/:level
   *
   * Full list for one location tier (countries | regions | cities), ordered by
   * item count descending and capped at 500.  Scoped under `explore/locations/`
   * so it never shadows the `/:id` media route.
   */
  @Get('explore/locations/:level')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Explore: full list for one location tier (countries|regions|cities)',
  })
  @ApiParam({ name: 'level', enum: ['countries', 'regions', 'cities'] })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Full list for the requested tier ordered by item count desc (max 500)',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          countryCode: { type: 'string', nullable: true },
          count: { type: 'number' },
          coverThumbnailUrl: { type: 'string', nullable: true },
        },
      },
    },
  })
  async exploreLocationLevel(
    @Param('level') level: string,
    @Query('circleId') circleId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.exploreLocationLevel(circleId, level, user.id, user.permissions);
  }

  /**
   * GET /api/media/facets/locations
   *
   * Returns the distinct geo hierarchy (Country → Region → Locality) present
   * in the circle's non-deleted, geocoded media items.  Intended for cascading
   * pick-lists in the search UI so users see only real values from their library.
   */
  @Get('facets/locations')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Geo facets: Country → Region → Locality hierarchy with item counts',
    description:
      'Returns every country (with optional region and locality breakdowns) that has ' +
      'at least one non-deleted, geocoded media item in the circle. ' +
      'All levels are sorted by item count descending. ' +
      'Null region / locality tiers are omitted.',
  })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Nested geo facets sorted by count descending',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          country: { type: 'string' },
          countryCode: { type: 'string', nullable: true },
          count: { type: 'number' },
          regions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                count: { type: 'number' },
                localities: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      count: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  async facetsLocations(
    @Query('circleId') circleId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.facetsLocations(circleId, user.id, user.permissions);
  }

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
  @ApiQuery({ name: 'albumId', required: false, type: String, format: 'uuid', description: 'Scope the map to members of a single album' })
  @ApiQuery({ name: 'bbox', required: false, type: String, description: 'Viewport bounding box "minLng,minLat,maxLng,maxLat" — restrict to items within these bounds' })
  @ApiResponse({ status: 200, description: 'Array of geotagged media location objects' })
  async listLocations(
    @Query() query: MediaLocationsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.listLocations(query, user.id, user.permissions);
  }

  /**
   * GET /api/media/locations/aggregate
   *
   * Server-side spatial clustering for the map view. Groups geotagged,
   * non-deleted / non-archived items into a grid (cell size controlled by
   * `precision`) and returns one cluster per occupied cell.
   * Declared before @Get(':id') so it is never shadowed.
   */
  @Get('locations/aggregate')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Server-side spatial clustering of geotagged media for the map view',
    description:
      'Groups geotagged non-deleted / non-archived items in the circle into a grid ' +
      'whose cell size is controlled by `precision` (decimal places of lat/lng rounding). ' +
      'Returns one cluster per occupied cell: { lat, lng, count, sampleId }.',
  })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid', description: 'Circle to aggregate' })
  @ApiQuery({ name: 'precision', required: false, type: Number, description: 'Grid precision (decimal places, 0–5; default 3)' })
  @ApiQuery({ name: 'bbox', required: false, type: String, description: 'Viewport bounding box "minLng,minLat,maxLng,maxLat"' })
  @ApiQuery({ name: 'capturedAtFrom', required: false, type: String, description: 'ISO 8601 datetime — filter capturedAt >= from' })
  @ApiQuery({ name: 'capturedAtTo', required: false, type: String, description: 'ISO 8601 datetime — filter capturedAt <= to' })
  @ApiQuery({ name: 'type', required: false, enum: ['photo', 'video'], description: 'Filter by media type' })
  @ApiResponse({ status: 200, description: 'Array of location clusters { lat, lng, count, sampleId }' })
  async aggregateLocations(
    @Query() query: MediaLocationsAggregateQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.aggregateLocations(query, user.id, user.permissions);
  }

  /**
   * PATCH /api/media/bulk
   * Bulk update location or favorite on a set of media items.
   */
  @Patch('bulk')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Bulk update media items (location, favorite)' })
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
   * PATCH /api/media/bulk/archive
   * Bulk archive media items (sets archivedAt, hides from browse surfaces).
   */
  @Patch('bulk/archive')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk archive media items' })
  @ApiResponse({ status: 200, description: 'Items archived' })
  async bulkArchive(
    @Body() dto: BulkArchiveDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.bulkArchive(dto, user.id, user.permissions);
  }

  /**
   * PATCH /api/media/bulk/unarchive
   * Bulk unarchive media items (clears archivedAt, restores to browse surfaces).
   */
  @Patch('bulk/unarchive')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk unarchive media items' })
  @ApiResponse({ status: 200, description: 'Items unarchived' })
  async bulkUnarchive(
    @Body() dto: BulkArchiveDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.bulkUnarchive(dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/bulk/tags/rerun
   * Bulk re-enqueue auto-tagging for a selection of media items.
   */
  @Post('bulk/tags/rerun')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk re-run auto-tagging on selected media items' })
  @ApiResponse({ status: 200, description: '{ queued: number }' })
  async bulkRerunTags(
    @Body() dto: BulkArchiveDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.bulkRerunTags(dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/bulk/faces/rerun
   * Bulk re-enqueue face detection for a selection of media items.
   */
  @Post('bulk/faces/rerun')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk re-run face detection on selected media items' })
  @ApiResponse({ status: 200, description: '{ queued: number }' })
  async bulkRerunFaces(
    @Body() dto: BulkArchiveDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.bulkRerunFaces(dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/bulk/thumbnail/rerun
   * Bulk re-enqueue thumbnail regeneration for a selection of media items.
   */
  @Post('bulk/thumbnail/rerun')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk re-run thumbnail generation on selected media items' })
  @ApiResponse({ status: 200, description: '{ queued: number }' })
  async bulkRerunThumbnails(
    @Body() dto: BulkArchiveDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.bulkRerunThumbnails(dto, user.id, user.permissions);
  }

  /**
   * GET /api/media/archived
   * List archived media items for a circle (paginated).
   */
  @Get('archived')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List archived media items' })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated archived items' })
  async listArchived(
    @Query() query: ListArchivedQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.listArchived(query, user.id, user.permissions);
  }

  /**
   * GET /api/media/trash
   * List trashed (soft-deleted) media items for a circle (paginated).
   */
  @Get('trash')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List trashed media items' })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated trashed items' })
  async listTrash(
    @Query() query: ListTrashQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.listTrash(query, user.id, user.permissions);
  }

  /**
   * POST /api/media/trash/restore
   * Restore items from the trash (clears deletedAt).
   */
  @Post('trash/restore')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore items from trash' })
  @ApiResponse({ status: 200, description: 'Items restored, with conflicts list' })
  async restoreFromTrash(
    @Body() dto: RestoreFromTrashDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.restoreFromTrash(dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/trash/delete-forever
   * Permanently hard-delete trashed items (removes DB rows and blobs).
   */
  @Post('trash/delete-forever')
  @Auth({ permissions: [PERMISSIONS.MEDIA_DELETE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Permanently delete trashed items (hard delete)' })
  @ApiResponse({ status: 200, description: 'Items permanently deleted' })
  async deleteForever(
    @Body() dto: DeleteForeverDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.deleteForever(dto, user.id, user.permissions);
  }

  /**
   * POST /api/media/trash/empty
   * Hard-delete all trashed items in a circle (circle_admin only).
   */
  @Post('trash/empty')
  @Auth({ permissions: [PERMISSIONS.MEDIA_DELETE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Empty trash (hard delete all trashed items, circle_admin only)' })
  @ApiResponse({ status: 200, description: 'All trashed items permanently deleted' })
  async emptyTrash(
    @Body() dto: EmptyTrashDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.emptyTrash(dto, user.id, user.permissions);
  }

  /**
   * GET /api/media/geo/reverse
   * On-demand reverse geocoding for a coordinate pair.
   */
  @Get('geo/reverse')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Reverse geocode a coordinate pair on demand' })
  @ApiQuery({ name: 'lat', required: true, type: Number })
  @ApiQuery({ name: 'lng', required: true, type: Number })
  @ApiResponse({ status: 200, description: 'Geocoding result (null if not found)' })
  async reverseGeocodeOnDemand(
    @Query() query: ReverseGeocodeQueryDto,
  ) {
    return this.mediaService.reverseGeocodeOnDemand(query.lat, query.lng);
  }

  /**
   * GET /api/media/geo/search
   * Forward geocode — search places by name. Gated by GEO_FORWARD_SEARCH_ENABLED.
   */
  @Get('geo/search')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Search places by name (forward geocoding, requires GEO_FORWARD_SEARCH_ENABLED=true)' })
  @ApiQuery({ name: 'q', required: true, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Array of place results [{lat, lng, label}]' })
  @ApiResponse({ status: 503, description: 'Place search is disabled (GEO_FORWARD_SEARCH_ENABLED=false)' })
  async searchPlaces(
    @Query() query: GeoSearchQueryDto,
  ) {
    return this.mediaService.searchPlaces(query.q, query.limit);
  }

  /**
   * GET /api/media/dashboard
   * Returns dashboard aggregation: On This Day, recent, favorites, and review queue counts.
   */
  @Get('dashboard')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Get circle dashboard aggregation',
    description:
      'Returns On This Day (same month/day across all years), recent uploads, favorites, ' +
      'and counts for the review queue (total, unreviewed, low-value, missing-geo).',
  })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Dashboard data returned' })
  async getDashboard(
    @Query() query: DashboardQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.mediaService.getDashboard(query, user.id, user.permissions);
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
   * POST /api/media/albums/:id/items/by-filter
   */
  @Post('albums/:id/items/by-filter')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Add all media matching filters to an album' })
  @ApiParam({ name: 'id', description: 'Album ID', type: String })
  @ApiResponse({ status: 200, description: 'Number of items added' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Album not found' })
  async addAlbumItemsByFilter(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddAlbumItemsByFilterDto,
    @CurrentUser() user: RequestUser,
  ): Promise<{ added: number }> {
    return this.mediaService.addAlbumItemsByFilter(id, dto, user.id, user.permissions);
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
  @ApiQuery({ name: 'noFaces', required: false, type: Boolean, description: 'true = items with no faces (detected or manual), false = items with at least one face' })
  @ApiQuery({ name: 'personId', required: false, type: String, format: 'uuid', description: 'Filter media to items containing faces assigned to this person' })
  @ApiQuery({ name: 'personIds', required: false, type: String, description: 'Comma-separated UUIDs or repeated params; filter media to items containing faces for any/all of these people' })
  @ApiQuery({ name: 'peopleMatch', required: false, enum: ['any', 'all'], description: 'Match mode for personIds: any (OR, default) or all (AND)' })
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
    description: 'Mutable: capturedAt, capturedAtOffset, metadata, description, favorite.',
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

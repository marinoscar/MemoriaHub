import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { Prisma, BurstGroupStatus } from '@prisma/client';
import { CircleRole } from '@prisma/client';
import { FastifyReply } from 'fastify';
import { stringify as csvStringify } from 'csv-stringify';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSIONS } from '../common/constants/roles.constants';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
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
import { MediaMetadataSyncService } from './sync/media-metadata-sync.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { buildMediaWhere, wherePeople } from '../search/media-where.builder';
import { GEO_LOCATION_PROVIDER, GeoLocationProvider } from './geo/geo-location-provider.interface';
import { ForwardGeocodeService } from './geo/forward-geocode.service';
import { BulkUpdateMediaDto } from './dto/bulk-update-media.dto';
import { BulkTagsDto } from './dto/bulk-tags.dto';
import { BulkDeleteDto } from './dto/bulk-delete.dto';
import { BulkArchiveDto } from './dto/bulk-archive.dto';
import { ListArchivedQueryDto } from './dto/list-archived-query.dto';
import { ListTrashQueryDto } from './dto/list-trash-query.dto';
import { RestoreFromTrashDto } from './dto/restore-from-trash.dto';
import { DeleteForeverDto } from './dto/delete-forever.dto';
import { EmptyTrashDto } from './dto/empty-trash.dto';
import { geoResultToMediaColumns, GEO_CLEAR_COLUMNS } from './geo/geo-result.mapper';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { MediaEnrichmentService } from './enrichment/media-enrichment.service';
import { ALL_SYSTEM_TAG_NAMES } from '../social/social-detectors';

/** Shape of each element returned by listLocations. */
export interface MediaLocation {
  id: string;
  takenLat: number;
  takenLng: number;
  capturedAt: Date | null;
  geoLocality: string | null;
  thumbnailUrl: string | null;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly mediaMetadataSyncService: MediaMetadataSyncService,
    private readonly circleMembershipService: CircleMembershipService,
    @Inject(GEO_LOCATION_PROVIDER) private readonly geoProvider: GeoLocationProvider,
    private readonly forwardGeocodeService: ForwardGeocodeService,
    private readonly resolver: StorageProviderResolver,
    private readonly mediaEnrichmentService: MediaEnrichmentService,
  ) {}

  // ---------------------------------------------------------------------------
  // MediaItem CRUD
  // ---------------------------------------------------------------------------

  /**
   * Register a StorageObject as a MediaItem.
   * Validates that the referenced StorageObject exists and is owned by the caller.
   *
   * Deduplication by content hash:
   *   If `dto.contentHash` is supplied the service checks whether the caller
   *   already owns a non-deleted MediaItem with the same hash (fast path).
   *   If found the redundant StorageObject blob is cleaned up best-effort and
   *   the existing MediaItem is returned with `deduplicated: true`.
   *
   *   If no pre-existing item is found the MediaItem is created with the hash
   *   already set.  A concurrent registration of the same hash may still win
   *   the race and cause `prisma.mediaItem.create` to throw a P2002
   *   (partial unique index violation).  That is caught, the winner is fetched,
   *   the redundant blob cleaned up, and the winner returned as a dedup hit.
   *
   *   The `deduplicated` field is non-persisted — it is added to the returned
   *   object to signal to callers whether the result is a fresh create or a
   *   dedup hit (clients may use it to decide HTTP status codes or UI feedback).
   */
  async createMedia(dto: CreateMediaDto, userId: string, userPermissions: string[]) {
    // Verify the StorageObject exists and belongs to the caller
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: dto.storageObjectId },
    });

    if (!storageObject) {
      throw new NotFoundException(
        `StorageObject with id ${dto.storageObjectId} not found`,
      );
    }

    if (storageObject.uploadedById !== userId) {
      throw new ForbiddenException(
        'You do not own the referenced StorageObject',
      );
    }

    // Ensure this StorageObject is not already linked to a MediaItem
    const existing = await this.prisma.mediaItem.findUnique({
      where: { storageObjectId: dto.storageObjectId },
    });

    if (existing) {
      throw new BadRequestException(
        'This StorageObject is already linked to a MediaItem',
      );
    }

    await this.circleMembershipService.assertCircleAccess(userId, dto.circleId, userPermissions, 'collaborator' as CircleRole);

    // Normalize the client-supplied hash once
    const hash = dto.contentHash?.toLowerCase() ?? null;

    // -----------------------------------------------------------------------
    // Fast-path dedup: if the hash is known, check before hitting the DB
    // -----------------------------------------------------------------------
    if (hash) {
      const duplicate = await this.prisma.mediaItem.findFirst({
        where: { circleId: dto.circleId, contentHash: hash, deletedAt: null },
      });

      if (duplicate) {
        this.logger.log(
          `Dedup hit (pre-check): MediaItem ${duplicate.id} already owns hash ${hash}; ` +
            `cleaning up redundant StorageObject ${dto.storageObjectId}`,
        );
        await this.cleanupRedundantStorageObject(dto.storageObjectId, storageObject.storageKey);
        return { ...duplicate, deduplicated: true as const };
      }
    }

    // -----------------------------------------------------------------------
    // Create path — may race with a concurrent register for the same hash
    // -----------------------------------------------------------------------
    let mediaItem: Awaited<ReturnType<typeof this.prisma.mediaItem.create>>;

    try {
      mediaItem = await this.prisma.mediaItem.create({
        data: {
          storageObjectId: dto.storageObjectId,
          addedById: userId,
          circleId: dto.circleId,
          type: dto.type,
          source: dto.source,
          originalFilename: dto.originalFilename,
          capturedAt: dto.capturedAt ?? null,
          capturedAtOffset: dto.capturedAtOffset ?? null,
          description: dto.description ?? null,
          favorite: dto.favorite ?? false,
          metadata: dto.metadata ? (dto.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
          originalCreatedAt: dto.originalCreatedAt ?? null,
          sourcePath: dto.sourcePath ?? null,
          sourceDeviceId: dto.sourceDeviceId ?? null,
          sourceDeviceName: dto.sourceDeviceName ?? null,
          contentHash: hash,
        },
      });
    } catch (err) {
      // P2002 = unique constraint violation — the partial index on
      // (circle_id, content_hash) WHERE content_hash IS NOT NULL AND deleted_at IS NULL
      // fired because a concurrent request registered the same hash first.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        hash
      ) {
        this.logger.warn(
          `Dedup hit (P2002 race): concurrent register won for hash ${hash}; ` +
            `fetching winner and cleaning up redundant StorageObject ${dto.storageObjectId}`,
        );

        const winner = await this.prisma.mediaItem.findFirst({
          where: { circleId: dto.circleId, contentHash: hash, deletedAt: null },
        });

        if (!winner) {
          // Extremely unlikely: the winner was hard-deleted between our create
          // and this re-query. Rethrow so the caller gets a 500 and can retry.
          throw err;
        }

        await this.cleanupRedundantStorageObject(dto.storageObjectId, storageObject.storageKey);
        return { ...winner, deduplicated: true as const };
      }

      throw err;
    }

    this.logger.log(`MediaItem created: ${mediaItem.id} by user ${userId}`);

    // Best-effort: if processing already finished before this createMedia call
    // (i.e. OBJECT_PROCESSED_EVENT fired and no-op'd because no MediaItem
    // existed yet), apply the processor metadata now so the item is immediately
    // enriched rather than staying permanently un-enriched.
    // If processing has not run yet the call is a no-op (_processing absent).
    // If processing runs again after this, the event handler reapplies the same
    // values — idempotent by design (present-only overwrites).
    try {
      await this.mediaMetadataSyncService.syncFromStorageObject(mediaItem.storageObjectId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Post-create metadata sync failed for MediaItem ${mediaItem.id} ` +
          `(StorageObject ${mediaItem.storageObjectId}): ${msg}`,
      );
      // Never fail createMedia because of a sync issue
    }

    // Synchronously enqueue all upload-time enrichment jobs (auto_tagging,
    // face_detection, burst_detection) before returning. This is the single
    // authoritative trigger — job rows exist before createMedia returns,
    // regardless of client (CLI, web, Android) or timing. The service reads
    // feature flags and env kill-switches internally and never rethrows.
    await this.mediaEnrichmentService.enqueueUploadEnrichment({
      id: mediaItem.id,
      type: mediaItem.type,
      circleId: mediaItem.circleId,
      deletedAt: mediaItem.deletedAt,
    });

    return { ...mediaItem, deduplicated: false as const };
  }

  /**
   * Best-effort cleanup of a redundant StorageObject and its blob.
   *
   * Called when a duplicate is detected (pre-check or P2002 race) so that the
   * newly-uploaded but ultimately unused blob does not linger in storage.
   *
   * Both the blob delete and the DB row delete are wrapped independently: a
   * failure in either only logs a warning rather than failing the parent request.
   * The storage key is different from the original (it is the redundant one),
   * so deleting it is safe.
   */
  private async cleanupRedundantStorageObject(
    storageObjectId: string,
    storageKey: string,
  ): Promise<void> {
    try {
      await this.storageProvider.delete(storageKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to delete redundant blob (key=${storageKey}): ${msg} — continuing`,
      );
    }

    try {
      await this.prisma.storageObject.delete({ where: { id: storageObjectId } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to delete redundant StorageObject row (id=${storageObjectId}): ${msg} — continuing`,
      );
    }
  }

  /**
   * List caller's media with pagination and filters. Excludes soft-deleted items.
   */
  async listMedia(query: MediaQueryDto, userId: string, userPermissions: string[]) {
    const {
      circleId,
      page,
      pageSize,
      type,
      capturedAtFrom,
      capturedAtTo,
      albumId,
      favorite,
      tag,
      country,
      region,
      locality,
      place,
      location,
      contentHash,
      sortBy,
      sortOrder,
      cameraMake,
      cameraModel,
      sourceDeviceId,
      sourceDeviceName,
      missingGeo,
      noFaces,
      personId,
      personIds,
      peopleMatch,
    } = query;

    const skip = (page - 1) * pageSize;

    await this.circleMembershipService.assertCircleAccess(userId, circleId, userPermissions, 'viewer' as CircleRole);

    // Resolve which person filter to apply (personIds takes precedence over personId)
    const effectivePersonIds =
      personIds && personIds.length > 0
        ? personIds
        : personId
          ? [personId]
          : [];
    const effectiveMode = peopleMatch ?? 'any';

    const where = {
      ...buildMediaWhere(circleId, {
        type,
        capturedAtFrom,
        capturedAtTo,
        albumId,
        favorite,
        tag,
        country,
        region,
        locality,
        place,
        location,
        contentHash,
        cameraMake,
        cameraModel,
        sourceDeviceId,
        sourceDeviceName,
        missingGeo,
        noFaces,
        excludeArchived: true,
      }),
      ...(effectivePersonIds.length > 0 ? wherePeople(effectivePersonIds, effectiveMode) : {}),
    };

    const orderBy: Prisma.MediaItemOrderByWithRelationInput = {
      [sortBy]: sortOrder,
    };

    const [items, totalItems] = await Promise.all([
      this.prisma.mediaItem.findMany({
        where,
        orderBy,
        skip,
        take: pageSize,
      }),
      this.prisma.mediaItem.count({ where }),
    ]);

    // Sign thumbnail URLs for all items in parallel (no extra DB query —
    // thumbnailStorageKey is already embedded in item.metadata).
    const itemsWithUrls = await Promise.all(
      items.map(async (item) => ({
        ...item,
        thumbnailUrl: await this.signThumb(item.metadata),
      })),
    );

    return {
      items: itemsWithUrls,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  /**
   * Return ALL geotagged (takenLat + takenLng non-null) non-deleted media items
   * for the caller — no pagination. Used by the map view.
   *
   * Applies the same ownership guard and geo/date/type filters as listMedia
   * but returns only the fields needed to render map pins:
   *   id, takenLat, takenLng, capturedAt, geoLocality, thumbnailUrl.
   *
   * thumbnailUrl is signed in parallel (same signThumb helper as listMedia).
   */
  async listLocations(
    query: MediaLocationsQueryDto,
    userId: string,
    userPermissions: string[],
  ): Promise<MediaLocation[]> {
    const {
      circleId,
      type,
      capturedAtFrom,
      capturedAtTo,
      country,
      region,
      locality,
      place,
      location,
    } = query;

    await this.circleMembershipService.assertCircleAccess(userId, circleId, userPermissions, 'viewer' as CircleRole);

    const where: Prisma.MediaItemWhereInput = {
      circleId,
      // Must have coordinates
      takenLat: { not: null },
      takenLng: { not: null },
      // Exclude soft-deleted and archived items
      deletedAt: null,
      archivedAt: null,
      // Optional type filter
      ...(type && { type }),
      // Date range
      ...(capturedAtFrom || capturedAtTo
        ? {
            capturedAt: {
              ...(capturedAtFrom && { gte: capturedAtFrom }),
              ...(capturedAtTo && { lte: capturedAtTo }),
            },
          }
        : {}),
      // Individual geo filters
      ...(country
        ? {
            OR: [
              {
                geoCountry: { contains: country, mode: 'insensitive' as const },
              },
              {
                geoCountryCode: { equals: country, mode: 'insensitive' as const },
              },
            ],
          }
        : {}),
      ...(region
        ? { geoAdmin1: { contains: region, mode: 'insensitive' as const } }
        : {}),
      ...(locality
        ? { geoLocality: { contains: locality, mode: 'insensitive' as const } }
        : {}),
      ...(place
        ? { geoPlaceName: { contains: place, mode: 'insensitive' as const } }
        : {}),
      // Combined free-text location search across all geo tiers
      ...(location
        ? {
            OR: [
              {
                geoCountry: { contains: location, mode: 'insensitive' as const },
              },
              {
                geoCountryCode: {
                  contains: location,
                  mode: 'insensitive' as const,
                },
              },
              {
                geoAdmin1: { contains: location, mode: 'insensitive' as const },
              },
              {
                geoLocality: {
                  contains: location,
                  mode: 'insensitive' as const,
                },
              },
              {
                geoPlaceName: {
                  contains: location,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.mediaItem.findMany({
      where,
      select: {
        id: true,
        takenLat: true,
        takenLng: true,
        capturedAt: true,
        geoLocality: true,
        metadata: true,
      },
      orderBy: { capturedAt: 'desc' },
    });

    // Sign all thumbnails in parallel; metadata is used only as signThumb input
    // and is NOT included in the returned objects.
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        takenLat: row.takenLat as number,
        takenLng: row.takenLng as number,
        capturedAt: row.capturedAt,
        geoLocality: row.geoLocality,
        thumbnailUrl: await this.signThumb(row.metadata),
      })),
    );
  }

  /**
   * Get one MediaItem. Ownership or media:read_any required.
   *
   * Returns the item with two additional signed-URL fields:
   *   thumbnailUrl  — fresh signed URL for the thumbnail (null if no thumbnail)
   *   downloadUrl   — fresh signed URL for the original full-res blob (null if
   *                   the linked StorageObject row is missing)
   *
   * BigInt safety: we only select `storageKey` from StorageObject, so the
   * BigInt `size` field never appears in the returned object.
   */
  async getMedia(id: string, userId: string, userPermissions: string[]) {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id },
      include: {
        mediaTags: {
          include: { tag: true },
        },
      },
    });

    if (!item || item.deletedAt !== null) {
      throw new NotFoundException(`MediaItem with id ${id} not found`);
    }

    await this.circleMembershipService.assertCircleAccess(userId, item.circleId, userPermissions, 'viewer' as CircleRole);

    // Fetch only the fields needed to sign the download URL (avoids spreading
    // BigInt `size` into the response; storageProvider + bucket are needed to
    // route signing through the correct per-object provider).
    const storageObj = await this.prisma.storageObject.findUnique({
      where: { id: item.storageObjectId },
      select: { storageKey: true, storageProvider: true, bucket: true },
    });

    const [thumbnailUrl, downloadUrl] = await Promise.all([
      this.signThumb(item.metadata),
      storageObj
        ? this.resolver
            .getProviderFor(storageObj.storageProvider, storageObj.bucket)
            .then((p) => p.getSignedDownloadUrl(storageObj.storageKey))
        : Promise.resolve(null),
    ]);

    const { mediaTags, ...rest } = item;

    return {
      ...rest,
      // `tags` carries every tag name (system + manual + AI); `systemTags` is the
      // subset flagged read-only. The web client renders chips from `tags` and
      // cross-references `systemTags` to lock the protected ones, so system tag
      // names MUST remain present in `tags` for them to appear at all.
      tags: mediaTags.map((mt) => mt.tag.name),
      systemTags: mediaTags.filter((mt) => mt.tag.isSystem).map((mt) => mt.tag.name),
      thumbnailUrl,
      downloadUrl,
    };
  }

  /**
   * Update mutable fields on a MediaItem.
   */
  async updateMedia(
    id: string,
    dto: UpdateMediaDto,
    userId: string,
    userPermissions: string[],
  ) {
    const item = await this.getMediaWithOwnershipCheck(
      id,
      userId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    const updated = await this.prisma.mediaItem.update({
      where: { id: item.id },
      data: {
        ...(dto.capturedAt !== undefined && { capturedAt: dto.capturedAt }),
        ...(dto.capturedAtOffset !== undefined && {
          capturedAtOffset: dto.capturedAtOffset,
        }),
        ...(dto.metadata !== undefined && {
          metadata:
            dto.metadata !== null
              ? (dto.metadata as Prisma.InputJsonValue)
              : Prisma.JsonNull,
        }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.favorite !== undefined && { favorite: dto.favorite }),
      },
    });

    this.logger.log(`MediaItem updated: ${id} by user ${userId}`);

    return updated;
  }

  /**
   * Soft-delete a MediaItem. Sets deletedAt; does NOT touch the StorageObject.
   */
  async deleteMedia(id: string, userId: string, userPermissions: string[]) {
    const item = await this.getMediaWithOwnershipCheck(
      id,
      userId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    await this.prisma.mediaItem.update({
      where: { id: item.id },
      data: { deletedAt: new Date() },
    });

    this.logger.log(`MediaItem soft-deleted: ${id} by user ${userId}`);
  }

  // ---------------------------------------------------------------------------
  // Tag endpoints
  // ---------------------------------------------------------------------------

  /**
   * List the caller's tags with the count of active (non-deleted) MediaItems attached.
   */
  async listTags(circleId: string, userId: string, userPermissions: string[]) {
    await this.circleMembershipService.assertCircleAccess(userId, circleId, userPermissions, 'viewer' as CircleRole);

    const tags = await this.prisma.tag.findMany({
      where: { circleId },
      include: {
        _count: {
          select: {
            mediaTags: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    return tags.map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      count: t._count.mediaTags,
    }));
  }

  /**
   * Attach one or more tags (by name) to a MediaItem. Creates Tag rows idempotently.
   */
  async attachTags(
    mediaItemId: string,
    dto: AttachTagsDto,
    userId: string,
    userPermissions: string[],
  ) {
    const item = await this.getMediaWithOwnershipCheck(
      mediaItemId,
      userId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    // Guard: system tag names cannot be manually applied
    const systemTagNamesLower = ALL_SYSTEM_TAG_NAMES.map((n) => n.toLowerCase());
    for (const name of dto.names) {
      if (systemTagNamesLower.includes(name.toLowerCase())) {
        throw new BadRequestException(`Tag name "${name}" is reserved as a system tag and cannot be applied manually`);
      }
    }

    const result: Array<{ tagId: string; name: string }> = [];

    for (const name of dto.names) {
      // Upsert Tag (idempotent per circleId + name unique constraint)
      const tag = await this.prisma.tag.upsert({
        where: { circleId_name: { circleId: item.circleId, name } },
        create: { addedById: userId, circleId: item.circleId, name },
        update: {},
      });

      // Upsert MediaTag join; create as manual, promote ai→manual on conflict
      await this.prisma.mediaTag.upsert({
        where: { tagId_mediaItemId: { tagId: tag.id, mediaItemId: item.id } },
        create: { tagId: tag.id, mediaItemId: item.id, source: 'manual' },
        update: { source: 'manual' },
      });

      result.push({ tagId: tag.id, name: tag.name });
    }

    this.logger.log(
      `Attached ${dto.names.length} tag(s) to MediaItem ${mediaItemId}`,
    );

    return result;
  }

  /**
   * Remove a tag from a MediaItem (removes the MediaTag join only; Tag record persists).
   */
  async removeTag(
    mediaItemId: string,
    tagId: string,
    userId: string,
    userPermissions: string[],
  ) {
    await this.getMediaWithOwnershipCheck(
      mediaItemId,
      userId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    const mediaTag = await this.prisma.mediaTag.findUnique({
      where: { tagId_mediaItemId: { tagId, mediaItemId } },
      include: { tag: { select: { isSystem: true, name: true } } },
    });

    if (!mediaTag) {
      throw new NotFoundException(
        `Tag ${tagId} is not attached to media item ${mediaItemId}`,
      );
    }

    // System tags can now be removed manually (reverse of the social gate).
    // When a system tag is removed we also update MediaSocialStatus.detected to
    // false for display consistency (the gate keys off tag presence, not status).
    const wasSystemTag = mediaTag.tag.isSystem;

    await this.prisma.mediaTag.delete({
      where: { tagId_mediaItemId: { tagId, mediaItemId } },
    });

    if (wasSystemTag) {
      // Best-effort: update the detected flag on mediaSocialStatus so the UI
      // correctly reflects that the item is no longer considered social media.
      try {
        await this.prisma.mediaSocialStatus.updateMany({
          where: { mediaItemId },
          data: { detected: false },
        });
      } catch {
        // Non-fatal — status display is informational only
      }
    }

    this.logger.log(`Removed tag ${tagId} from MediaItem ${mediaItemId}${wasSystemTag ? ' (system tag — social gate released)' : ''}`);
  }

  // ---------------------------------------------------------------------------
  // Album CRUD
  // ---------------------------------------------------------------------------

  /**
   * Create a new album owned by the caller.
   */
  async createAlbum(dto: CreateAlbumDto, userId: string, userPermissions: string[]) {
    await this.circleMembershipService.assertCircleAccess(userId, dto.circleId, userPermissions, 'collaborator' as CircleRole);

    const album = await this.prisma.album.create({
      data: {
        addedById: userId,
        circleId: dto.circleId,
        name: dto.name,
        description: dto.description ?? null,
      },
    });

    this.logger.log(`Album created: ${album.id} by user ${userId}`);

    return album;
  }

  /**
   * List caller's albums with pagination.
   */
  async listAlbums(query: AlbumQueryDto, userId: string, userPermissions: string[]) {
    const { circleId, page, pageSize, sortBy, sortOrder } = query;
    const skip = (page - 1) * pageSize;

    await this.circleMembershipService.assertCircleAccess(userId, circleId, userPermissions, 'viewer' as CircleRole);

    const where: Prisma.AlbumWhereInput = { circleId };

    const [items, totalItems] = await Promise.all([
      this.prisma.album.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: pageSize,
        include: {
          _count: { select: { items: true } },
        },
      }),
      this.prisma.album.count({ where }),
    ]);

    return {
      items,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  /**
   * Get one album (with its items). Ownership or media:read_any required.
   */
  async getAlbum(id: string, userId: string, userPermissions: string[]) {
    const album = await this.prisma.album.findUnique({
      where: { id },
      include: {
        items: {
          where: { mediaItem: { deletedAt: null, archivedAt: null } },
          include: { mediaItem: true },
          orderBy: { addedAt: 'asc' },
        },
      },
    });

    if (!album) {
      throw new NotFoundException(`Album with id ${id} not found`);
    }

    await this.circleMembershipService.assertCircleAccess(userId, album.circleId, userPermissions, 'viewer' as CircleRole);

    return album;
  }

  /**
   * Update an album's mutable fields.
   */
  async updateAlbum(
    id: string,
    dto: UpdateAlbumDto,
    userId: string,
    userPermissions: string[],
  ) {
    const album = await this.getAlbumWithOwnershipCheck(
      id,
      userId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    const updated = await this.prisma.album.update({
      where: { id: album.id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
      },
    });

    this.logger.log(`Album updated: ${id} by user ${userId}`);

    return updated;
  }

  /**
   * Delete an album and its AlbumItem joins. Does NOT delete MediaItems.
   */
  async deleteAlbum(id: string, userId: string, userPermissions: string[]) {
    await this.getAlbumWithOwnershipCheck(
      id,
      userId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    // Cascade in the schema deletes AlbumItems when Album is deleted
    await this.prisma.album.delete({ where: { id } });

    this.logger.log(`Album deleted: ${id} by user ${userId}`);
  }

  /**
   * Add MediaItems to an album (idempotent for existing joins).
   */
  async addAlbumItems(
    albumId: string,
    dto: AddAlbumItemsDto,
    userId: string,
    userPermissions: string[],
  ) {
    const album = await this.getAlbumWithOwnershipCheck(
      albumId,
      userId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    // Verify all mediaItemIds exist and belong to the same circle
    const mediaItems = await this.prisma.mediaItem.findMany({
      where: {
        id: { in: dto.mediaItemIds },
        deletedAt: null,
        circleId: album.circleId,
      },
    });

    if (mediaItems.length !== dto.mediaItemIds.length) {
      const foundIds = new Set(mediaItems.map((m) => m.id));
      const missing = dto.mediaItemIds.filter((id) => !foundIds.has(id));
      throw new NotFoundException(
        `MediaItems not found or not accessible: ${missing.join(', ')}`,
      );
    }

    const created: Array<{ id: string; albumId: string; mediaItemId: string; addedAt: Date }> = [];

    for (const mediaItemId of dto.mediaItemIds) {
      const item = await this.prisma.albumItem.upsert({
        where: { albumId_mediaItemId: { albumId: album.id, mediaItemId } },
        create: { albumId: album.id, mediaItemId },
        update: {},
      });
      created.push(item);
    }

    this.logger.log(
      `Added ${dto.mediaItemIds.length} item(s) to album ${albumId}`,
    );

    return created;
  }

  /**
   * Add all MediaItems matching a filter set to an album (idempotent for existing joins).
   * Forces the effective circleId to match the album's circle, ignoring any client-supplied mismatch.
   */
  async addAlbumItemsByFilter(
    albumId: string,
    dto: AddAlbumItemsByFilterDto,
    userId: string,
    userPermissions: string[],
  ): Promise<{ added: number }> {
    const album = await this.getAlbumWithOwnershipCheck(albumId, userId, userPermissions, 'collaborator' as CircleRole);

    // Force the circle to match the album's circle — ignore any client-supplied circleId mismatch
    const {
      type,
      capturedAtFrom,
      capturedAtTo,
      albumId: filterAlbumId,
      favorite,
      tag,
      country,
      region,
      locality,
      place,
      location,
      contentHash,
      cameraMake,
      cameraModel,
      sourceDeviceId,
      sourceDeviceName,
      missingGeo,
      noFaces,
      personId,
      personIds,
      peopleMatch,
    } = dto;

    const where = {
      ...buildMediaWhere(album.circleId, {
        type,
        capturedAtFrom,
        capturedAtTo,
        albumId: filterAlbumId,
        favorite,
        tag,
        country,
        region,
        locality,
        place,
        location,
        contentHash,
        cameraMake,
        cameraModel,
        sourceDeviceId,
        sourceDeviceName,
        missingGeo,
        noFaces,
        excludeArchived: true,
      }),
      ...(() => {
        const effectivePersonIds =
          personIds && personIds.length > 0
            ? personIds
            : personId
              ? [personId]
              : [];
        const effectiveMode = peopleMatch ?? 'any';
        return effectivePersonIds.length > 0 ? wherePeople(effectivePersonIds, effectiveMode) : {};
      })(),
    };

    const matches = await this.prisma.mediaItem.findMany({
      where,
      select: { id: true },
    });

    // Batch inserts in chunks of 1000
    const CHUNK_SIZE = 1000;
    let totalAdded = 0;
    for (let i = 0; i < matches.length; i += CHUNK_SIZE) {
      const chunk = matches.slice(i, i + CHUNK_SIZE);
      const result = await this.prisma.albumItem.createMany({
        data: chunk.map((m) => ({ albumId: album.id, mediaItemId: m.id })),
        skipDuplicates: true,
      });
      totalAdded += result.count;
    }

    this.logger.log(`Added ${totalAdded} item(s) to album ${albumId} by filter`);
    return { added: totalAdded };
  }

  /**
   * Remove a MediaItem from an album.
   */
  async removeAlbumItem(
    albumId: string,
    itemId: string,
    userId: string,
    userPermissions: string[],
  ) {
    await this.getAlbumWithOwnershipCheck(
      albumId,
      userId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    const albumItem = await this.prisma.albumItem.findUnique({
      where: { albumId_mediaItemId: { albumId, mediaItemId: itemId } },
    });

    if (!albumItem) {
      throw new NotFoundException(
        `MediaItem ${itemId} is not in album ${albumId}`,
      );
    }

    await this.prisma.albumItem.delete({
      where: { albumId_mediaItemId: { albumId, mediaItemId: itemId } },
    });

    this.logger.log(
      `Removed MediaItem ${itemId} from album ${albumId} by user ${userId}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Metadata export (streaming, cursor-based)
  // ---------------------------------------------------------------------------

  /**
   * Stream all MediaItem metadata for the target owner in JSON (NDJSON) or CSV format.
   *
   * Ownership resolution:
   *   - If dto.ownerId is provided and differs from userId → requires MEDIA_READ_ANY.
   *   - If dto.ownerId is omitted → target = userId (own records only).
   *   - If caller holds MEDIA_READ_ANY and sets ownerId → use ownerId as target.
   *
   * The 403 check is performed BEFORE any response bytes are written so the
   * Nest exception filter can still produce a proper error response.
   *
   * BigInt safety: storageObject.size is a PostgreSQL bigint (Prisma maps it
   * to JS BigInt). We convert it to Number via Number(size) before any
   * JSON.stringify call so we never hit the "BigInt cannot be serialised"
   * TypeError.
   */
  async streamExport(
    dto: ExportQueryDto,
    userId: string,
    userPermissions: string[],
    res: FastifyReply,
  ): Promise<void> {
    // ------------------------------------------------------------------
    // 1. Circle access check (MUST happen before first write)
    // ------------------------------------------------------------------
    const { circleId, type, from, to } = dto;
    await this.circleMembershipService.assertCircleAccess(userId, circleId, userPermissions, 'viewer' as CircleRole);

    // ------------------------------------------------------------------
    // 2. Build Prisma where clause
    // ------------------------------------------------------------------
    const where: Prisma.MediaItemWhereInput = {
      circleId,
      deletedAt: null,
      ...(type && { type }),
      ...((from ?? to)
        ? {
            capturedAt: {
              ...(from && { gte: from }),
              ...(to && { lte: to }),
            },
          }
        : {}),
    };

    // ------------------------------------------------------------------
    // 3. Set streaming response headers (before first write)
    // ------------------------------------------------------------------
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const isJson = dto.format === 'json';
    const ext = isJson ? 'json' : 'csv';
    const contentType = isJson
      ? 'application/json'
      : 'text/csv; charset=utf-8';

    res.raw.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="memoriahub-export-${dateStr}.${ext}"`,
      'Transfer-Encoding': 'chunked',
    });

    // ------------------------------------------------------------------
    // 4. Stream records using cursor-based pagination (no full-load)
    // ------------------------------------------------------------------
    const BATCH_SIZE = 100;

    /** Build the export-record object from a raw Prisma row. */
    const toRecord = (item: {
      id: string;
      originalFilename: string;
      type: string;
      capturedAt: Date | null;
      importedAt: Date;
      source: string;
      width: number | null;
      height: number | null;
      durationMs: number | null;
      takenLat: number | null;
      takenLng: number | null;
      cameraMake: string | null;
      cameraModel: string | null;
      contentHash: string | null;
      metadata: Prisma.JsonValue | null;
      storageObject: {
        storageProvider: string;
        storageKey: string;
        size: bigint;
      } | null;
    }) => ({
      id: item.id,
      originalFilename: item.originalFilename,
      type: item.type,
      capturedAt: item.capturedAt?.toISOString() ?? null,
      importedAt: item.importedAt.toISOString(),
      source: item.source,
      width: item.width,
      height: item.height,
      durationMs: item.durationMs,
      takenLat: item.takenLat,
      takenLng: item.takenLng,
      cameraMake: item.cameraMake,
      cameraModel: item.cameraModel,
      contentHash: item.contentHash,
      metadata: item.metadata ?? {},
      storage: item.storageObject
        ? {
            provider: item.storageObject.storageProvider,
            key: item.storageObject.storageKey,
            // Convert BigInt → Number before serialisation
            size: Number(item.storageObject.size),
          }
        : null,
    });

    if (isJson) {
      // ----------------------------------------------------------------
      // JSON path: newline-delimited JSON (NDJSON), one object per line
      // ----------------------------------------------------------------
      let cursor: string | undefined;
      let done = false;

      while (!done) {
        const batch = await this.prisma.mediaItem.findMany({
          where,
          include: {
            storageObject: {
              select: {
                storageProvider: true,
                storageKey: true,
                size: true,
              },
            },
          },
          orderBy: { id: 'asc' },
          take: BATCH_SIZE,
          ...(cursor
            ? { cursor: { id: cursor }, skip: 1 }
            : {}),
        });

        for (const item of batch) {
          const record = toRecord(item);
          res.raw.write(JSON.stringify(record) + '\n');
        }

        if (batch.length < BATCH_SIZE) {
          done = true;
        } else {
          cursor = batch[batch.length - 1].id;
        }
      }

      res.raw.end();
    } else {
      // ----------------------------------------------------------------
      // CSV path: RFC 4180 via csv-stringify streaming API
      // ----------------------------------------------------------------
      const CSV_COLUMNS = [
        'id',
        'originalFilename',
        'type',
        'capturedAt',
        'importedAt',
        'source',
        'width',
        'height',
        'durationMs',
        'takenLat',
        'takenLng',
        'cameraMake',
        'cameraModel',
        'contentHash',
        'storage_provider',
        'storage_key',
        'storage_size',
        'metadata',
      ] as const;

      const stringifier = csvStringify({
        header: true,
        columns: CSV_COLUMNS as unknown as string[],
      });

      // Pipe the stringifier output into the raw Node response stream.
      stringifier.pipe(res.raw);

      let cursor: string | undefined;
      let done = false;

      while (!done) {
        const batch = await this.prisma.mediaItem.findMany({
          where,
          include: {
            storageObject: {
              select: {
                storageProvider: true,
                storageKey: true,
                size: true,
              },
            },
          },
          orderBy: { id: 'asc' },
          take: BATCH_SIZE,
          ...(cursor
            ? { cursor: { id: cursor }, skip: 1 }
            : {}),
        });

        for (const item of batch) {
          const record = toRecord(item);
          // Flatten nested storage.* and serialize metadata as JSON string
          stringifier.write({
            id: record.id,
            originalFilename: record.originalFilename,
            type: record.type,
            capturedAt: record.capturedAt,
            importedAt: record.importedAt,
            source: record.source,
            width: record.width,
            height: record.height,
            durationMs: record.durationMs,
            takenLat: record.takenLat,
            takenLng: record.takenLng,
            cameraMake: record.cameraMake,
            cameraModel: record.cameraModel,
            contentHash: record.contentHash,
            storage_provider: record.storage?.provider ?? null,
            storage_key: record.storage?.key ?? null,
            storage_size: record.storage?.size ?? null,
            metadata: JSON.stringify(record.metadata ?? {}),
          });
        }

        if (batch.length < BATCH_SIZE) {
          done = true;
        } else {
          cursor = batch[batch.length - 1].id;
        }
      }

      // Signal end; 'finish' on the underlying stream closes res.raw
      stringifier.end();
    }

    this.logger.log(
      `Media export (${dto.format}) streamed for circle ${circleId} by user ${userId}`,
    );
  }

  async reverseGeocodeOnDemand(lat: number, lng: number) {
    return this.geoProvider.reverseGeocode(lat, lng);
  }

  async searchPlaces(q: string, limit: number) {
    return this.forwardGeocodeService.searchPlaces(q, limit);
  }

  async getDashboard(query: DashboardQueryDto, userId: string, perms: string[]) {
    const { circleId } = query;

    await this.circleMembershipService.assertCircleAccess(userId, circleId, perms, 'viewer' as CircleRole);

    const now = new Date();
    const month = now.getUTCMonth() + 1; // 1-12
    const day = now.getUTCDate();        // 1-31

    // On This Day: raw SQL query using the functional index on
    // EXTRACT(MONTH/DAY FROM (captured_at AT TIME ZONE 'UTC')).
    // The AT TIME ZONE 'UTC' cast converts timestamptz → timestamp so that
    // EXTRACT is IMMUTABLE and the index expression matches exactly.
    // month/day are computed via getUTCMonth()/getUTCDate() above, so UTC
    // semantics are consistent between the index and this query.
    const onThisDayRaw = await this.prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT id FROM media_items
        WHERE circle_id = ${circleId}::uuid
          AND deleted_at IS NULL
          AND archived_at IS NULL
          AND captured_at IS NOT NULL
          AND EXTRACT(MONTH FROM (captured_at AT TIME ZONE 'UTC')) = ${month}
          AND EXTRACT(DAY FROM (captured_at AT TIME ZONE 'UTC')) = ${day}
        ORDER BY captured_at DESC
        LIMIT 24
      `,
    );

    const onThisDayIds = onThisDayRaw.map((r) => r.id);

    // Load burst minGroupSize from system settings for the dashboard count filter
    const burstSettings = await this.prisma.systemSettings.findUnique({
      where: { key: 'global' },
      select: { value: true },
    });
    const burstValue = (burstSettings?.value as Record<string, unknown> | null) ?? {};
    const burstConfig = burstValue['burst'] as { minGroupSize?: number } | undefined;
    const burstMinGroupSize = burstConfig?.minGroupSize ?? 3;

    const [onThisDayItems, recentItems, favoriteItems, totalCount, missingGeoCount, pendingBurstGroupsCount] =
      await Promise.all([
        onThisDayIds.length > 0
          ? this.prisma.mediaItem.findMany({
              where: { id: { in: onThisDayIds } },
              orderBy: { capturedAt: 'desc' },
            })
          : Promise.resolve([]),
        this.prisma.mediaItem.findMany({
          where: { circleId, deletedAt: null, archivedAt: null },
          orderBy: { importedAt: 'desc' },
          take: 12,
        }),
        this.prisma.mediaItem.findMany({
          where: { circleId, deletedAt: null, archivedAt: null, favorite: true },
          orderBy: { capturedAt: 'desc' },
          take: 12,
        }),
        this.prisma.mediaItem.count({ where: { circleId, deletedAt: null, archivedAt: null } }),
        this.prisma.mediaItem.count({
          where: { circleId, deletedAt: null, archivedAt: null, takenLat: null },
        }),
        this.prisma.burstGroup.count({
          where: {
            circleId,
            status: BurstGroupStatus.pending,
            mediaCount: { gte: burstMinGroupSize },
          },
        }),
      ]);

    const [onThisDay, recent, favorites] = await Promise.all([
      Promise.all(
        onThisDayItems.map(async (item) => ({
          ...item,
          thumbnailUrl: await this.signThumb(item.metadata),
        })),
      ),
      Promise.all(
        recentItems.map(async (item) => ({
          ...item,
          thumbnailUrl: await this.signThumb(item.metadata),
        })),
      ),
      Promise.all(
        favoriteItems.map(async (item) => ({
          ...item,
          thumbnailUrl: await this.signThumb(item.metadata),
        })),
      ),
    ]);

    return {
      onThisDay,
      recent,
      favorites,
      counts: {
        total: totalCount,
        missingGeo: missingGeoCount,
      },
      pendingBurstGroups: pendingBurstGroupsCount,
    };
  }

  async bulkUpdateMedia(
    dto: BulkUpdateMediaDto,
    userId: string,
    perms: string[],
  ): Promise<{ updated: number }> {
    await this.assertAllInCircle(dto.ids, dto.circleId, userId, perms, 'collaborator' as CircleRole);

    const data: Record<string, unknown> = {};

    if (dto.set.favorite !== undefined) {
      data['favorite'] = dto.set.favorite;
    }

    if (dto.set.location === null) {
      Object.assign(data, GEO_CLEAR_COLUMNS);
    } else if (dto.set.location !== undefined) {
      const { lat, lng, altitude } = dto.set.location;
      const result = await this.geoProvider.reverseGeocode(lat, lng);
      Object.assign(data, {
        takenLat: lat,
        takenLng: lng,
        takenAltitude: altitude ?? null,
        ...geoResultToMediaColumns(result ?? {}, 'manual'),
      });
    }

    if (dto.set.capturedAt !== undefined) {
      data['capturedAt'] = dto.set.capturedAt; // Date | null (coerced by the DTO)
    }

    const { count } = await this.prisma.mediaItem.updateMany({
      where: { id: { in: dto.ids }, circleId: dto.circleId, deletedAt: null },
      data,
    });

    this.logger.log(
      `bulkUpdateMedia: updated ${count} items in circle ${dto.circleId} by user ${userId}`,
    );

    return { updated: count };
  }

  async bulkTags(
    dto: BulkTagsDto,
    userId: string,
    perms: string[],
  ): Promise<{ added: number; removed: number }> {
    await this.assertAllInCircle(dto.ids, dto.circleId, userId, perms, 'collaborator' as CircleRole);

    let added = 0;
    let removed = 0;

    await this.prisma.$transaction(async (tx) => {
      if (dto.add && dto.add.length > 0) {
        // Guard: system tag names cannot be used as manual tags
        const systemTagNamesLower = ALL_SYSTEM_TAG_NAMES.map((n) => n.toLowerCase());
        for (const name of dto.add) {
          if (systemTagNamesLower.includes(name.toLowerCase())) {
            throw new BadRequestException(`Tag name "${name}" is reserved as a system tag and cannot be used`);
          }
        }

        const tagIds: string[] = [];
        for (const name of dto.add) {
          const tag = await tx.tag.upsert({
            where: { circleId_name: { circleId: dto.circleId, name } },
            create: { addedById: userId, circleId: dto.circleId, name },
            update: {},
          });
          tagIds.push(tag.id);
        }

        // Add source=manual to each pair
        const pairsWithSource = dto.ids.flatMap((mediaItemId) =>
          tagIds.map((tagId) => ({ mediaItemId, tagId, source: 'manual' as const })),
        );
        const result = await tx.mediaTag.createMany({ data: pairsWithSource, skipDuplicates: true });
        // Promote any existing ai-sourced tags to manual for these pairs (never promote system tags)
        await tx.mediaTag.updateMany({
          where: {
            tagId: { in: tagIds },
            mediaItemId: { in: dto.ids },
            source: 'ai',
          },
          data: { source: 'manual' },
        });
        added = result.count;
      }

      if (dto.remove && dto.remove.length > 0) {
        // System tags CAN be removed via bulk ops (manual override of social gate).
        const tags = await tx.tag.findMany({
          where: {
            circleId: dto.circleId,
            name: { in: dto.remove },
          },
          select: { id: true, isSystem: true },
        });
        if (tags.length > 0) {
          const removeTagIds = tags.map((t) => t.id);
          const result = await tx.mediaTag.deleteMany({
            where: {
              tagId: { in: removeTagIds },
              mediaItemId: { in: dto.ids },
            },
          });
          removed = result.count;

          // If any removed tags were system tags, update mediaSocialStatus.detected
          // for display consistency (best-effort, non-fatal).
          const hasSystemTags = tags.some((t) => t.isSystem);
          if (hasSystemTags) {
            try {
              await tx.mediaSocialStatus.updateMany({
                where: { mediaItemId: { in: dto.ids } },
                data: { detected: false },
              });
            } catch {
              // Non-fatal — status display is informational only
            }
          }
        }
      }
    });

    this.logger.log(
      `bulkTags: added=${added} removed=${removed} for ${dto.ids.length} items by user ${userId}`,
    );

    return { added, removed };
  }

  async bulkDelete(
    dto: BulkDeleteDto,
    userId: string,
    perms: string[],
  ): Promise<{ deleted: number }> {
    await this.assertAllInCircle(dto.ids, dto.circleId, userId, perms, 'collaborator' as CircleRole);

    const { count } = await this.prisma.mediaItem.updateMany({
      where: { id: { in: dto.ids }, circleId: dto.circleId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    this.logger.log(
      `bulkDelete: soft-deleted ${count} items in circle ${dto.circleId} by user ${userId}`,
    );

    return { deleted: count };
  }

  // ---------------------------------------------------------------------------
  // Archive / Trash methods
  // ---------------------------------------------------------------------------

  async bulkArchive(dto: BulkArchiveDto, userId: string, perms: string[]): Promise<{ archived: number }> {
    await this.assertAllInCircle(dto.ids, dto.circleId, userId, perms, 'collaborator' as CircleRole);

    const { count } = await this.prisma.mediaItem.updateMany({
      where: { id: { in: dto.ids }, circleId: dto.circleId, deletedAt: null, archivedAt: null },
      data: { archivedAt: new Date() },
    });

    this.logger.log(`bulkArchive: archived ${count} items in circle ${dto.circleId} by user ${userId}`);
    return { archived: count };
  }

  async bulkUnarchive(dto: BulkArchiveDto, userId: string, perms: string[]): Promise<{ unarchived: number }> {
    await this.circleMembershipService.assertCircleAccess(userId, dto.circleId, perms, 'collaborator' as CircleRole);

    const { count } = await this.prisma.mediaItem.updateMany({
      where: { id: { in: dto.ids }, circleId: dto.circleId, deletedAt: null, archivedAt: { not: null } },
      data: { archivedAt: null },
    });

    this.logger.log(`bulkUnarchive: unarchived ${count} items in circle ${dto.circleId} by user ${userId}`);
    return { unarchived: count };
  }

  async listArchived(query: ListArchivedQueryDto, userId: string, userPermissions: string[]) {
    const { circleId, page, pageSize } = query;
    const skip = (page - 1) * pageSize;

    await this.circleMembershipService.assertCircleAccess(userId, circleId, userPermissions, 'viewer' as CircleRole);

    const where: Prisma.MediaItemWhereInput = {
      circleId,
      deletedAt: null,
      archivedAt: { not: null },
    };

    const [items, totalItems] = await Promise.all([
      this.prisma.mediaItem.findMany({
        where,
        orderBy: { archivedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.mediaItem.count({ where }),
    ]);

    const itemsWithUrls = await Promise.all(
      items.map(async (item) => ({
        ...item,
        thumbnailUrl: await this.signThumb(item.metadata),
      })),
    );

    return {
      items: itemsWithUrls,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  async listTrash(query: ListTrashQueryDto, userId: string, userPermissions: string[]) {
    const { circleId, page, pageSize } = query;
    const skip = (page - 1) * pageSize;

    await this.circleMembershipService.assertCircleAccess(userId, circleId, userPermissions, 'viewer' as CircleRole);

    const where: Prisma.MediaItemWhereInput = {
      circleId,
      deletedAt: { not: null },
    };

    const [items, totalItems] = await Promise.all([
      this.prisma.mediaItem.findMany({
        where,
        orderBy: { deletedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.mediaItem.count({ where }),
    ]);

    const itemsWithUrls = await Promise.all(
      items.map(async (item) => ({
        ...item,
        thumbnailUrl: await this.signThumb(item.metadata),
      })),
    );

    return {
      items: itemsWithUrls,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  async restoreFromTrash(
    dto: RestoreFromTrashDto,
    userId: string,
    perms: string[],
  ): Promise<{ restored: number; conflicts: string[] }> {
    await this.circleMembershipService.assertCircleAccess(userId, dto.circleId, perms, 'collaborator' as CircleRole);

    let restored = 0;
    const conflicts: string[] = [];

    for (const id of dto.ids) {
      const item = await this.prisma.mediaItem.findFirst({
        where: { id, circleId: dto.circleId, deletedAt: { not: null } },
        select: { id: true, contentHash: true },
      });
      if (!item) continue;

      try {
        await this.prisma.mediaItem.update({
          where: { id },
          data: { deletedAt: null },
        });
        restored++;
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002') {
          conflicts.push(id);
        } else {
          throw err;
        }
      }
    }

    this.logger.log(
      `restoreFromTrash: restored=${restored} conflicts=${conflicts.length} in circle ${dto.circleId} by user ${userId}`,
    );
    return { restored, conflicts };
  }

  /**
   * Hard-delete a list of MediaItem IDs: deletes the DB row, removes the blob
   * from object storage, and removes the StorageObject row.
   * Each item is processed independently — failures are logged and skipped
   * rather than aborting the entire batch.
   */
  async purgeMediaItems(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const items = await this.prisma.mediaItem.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        storageObjectId: true,
        storageObject: { select: { id: true, storageKey: true } },
      },
    });

    let purged = 0;
    for (const item of items) {
      try {
        await this.prisma.mediaItem.delete({ where: { id: item.id } });

        if (item.storageObject?.storageKey) {
          try {
            await this.storageProvider.delete(item.storageObject.storageKey);
          } catch (blobErr) {
            const msg = blobErr instanceof Error ? blobErr.message : String(blobErr);
            this.logger.warn(`purgeMediaItems: blob delete failed for key=${item.storageObject.storageKey}: ${msg}`);
          }
        }

        if (item.storageObjectId) {
          try {
            await this.prisma.storageObject.delete({ where: { id: item.storageObjectId } });
          } catch (soErr) {
            const msg = soErr instanceof Error ? soErr.message : String(soErr);
            this.logger.warn(`purgeMediaItems: StorageObject delete failed for id=${item.storageObjectId}: ${msg}`);
          }
        }

        purged++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`purgeMediaItems: failed to purge item ${item.id}: ${msg}`);
      }
    }

    return purged;
  }

  async deleteForever(
    dto: DeleteForeverDto,
    userId: string,
    perms: string[],
  ): Promise<{ deleted: number }> {
    await this.circleMembershipService.assertCircleAccess(userId, dto.circleId, perms, 'collaborator' as CircleRole);

    const items = await this.prisma.mediaItem.findMany({
      where: { id: { in: dto.ids }, circleId: dto.circleId, deletedAt: { not: null } },
      select: { id: true },
    });

    const deleted = await this.purgeMediaItems(items.map((i) => i.id));
    this.logger.log(`deleteForever: purged ${deleted} items in circle ${dto.circleId} by user ${userId}`);
    return { deleted };
  }

  async emptyTrash(
    dto: EmptyTrashDto,
    userId: string,
    perms: string[],
  ): Promise<{ deleted: number }> {
    await this.circleMembershipService.assertCircleAccess(userId, dto.circleId, perms, 'circle_admin' as CircleRole);

    const items = await this.prisma.mediaItem.findMany({
      where: { circleId: dto.circleId, deletedAt: { not: null } },
      select: { id: true },
    });

    const deleted = await this.purgeMediaItems(items.map((i) => i.id));
    this.logger.log(`emptyTrash: purged ${deleted} items in circle ${dto.circleId} by user ${userId}`);
    return { deleted };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Verify circle access, then confirm all ids are non-deleted members of circleId.
   * Mirrors addAlbumItems cross-circle guard.
   * Throws NotFoundException if any id is missing, deleted, or in a different circle.
   */
  private async assertAllInCircle(
    ids: string[],
    circleId: string,
    userId: string,
    perms: string[],
    role: CircleRole,
  ): Promise<void> {
    await this.circleMembershipService.assertCircleAccess(userId, circleId, perms, role);

    const uniqueIds = [...new Set(ids)];

    const found = await this.prisma.mediaItem.findMany({
      where: { id: { in: uniqueIds }, circleId, deletedAt: null },
      select: { id: true },
    });

    if (found.length !== uniqueIds.length) {
      const foundSet = new Set(found.map((f) => f.id));
      const missing = uniqueIds.filter((id) => !foundSet.has(id));
      throw new NotFoundException(
        `MediaItems not found or not accessible: ${missing.join(', ')}`,
      );
    }
  }

  /**
   * Fetch a MediaItem (excluding soft-deleted) and enforce ownership/any-permission.
   * Throws 404 if not found (or deleted), 403 if ownership denied.
   */
  async getMediaWithOwnershipCheck(
    id: string,
    userId: string,
    userPermissions: string[],
    required: CircleRole,
  ) {
    const item = await this.prisma.mediaItem.findUnique({ where: { id } });

    if (!item || item.deletedAt !== null) {
      throw new NotFoundException(`MediaItem with id ${id} not found`);
    }

    await this.circleMembershipService.assertCircleAccess(userId, item.circleId, userPermissions, required);

    return item;
  }

  // ---------------------------------------------------------------------------
  // URL signing helpers
  // ---------------------------------------------------------------------------

  /**
   * Sign a fresh download URL for a thumbnail, or return null if the item has
   * no thumbnail yet (processor has not run / image not yet uploaded).
   *
   * Reads `thumbnailStorageKey` from the JSONB metadata field.  This is a
   * stable key (never signed), so it is safe to store in the DB.
   */
  private async signThumb(
    metadata: Prisma.JsonValue | null,
  ): Promise<string | null> {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }
    const meta = metadata as Record<string, unknown>;
    const key = meta['thumbnailStorageKey'];
    if (typeof key !== 'string' || !key) {
      return null;
    }
    try {
      // Look up the StorageObject row for the thumbnail to route signing
      // through the correct provider (the active provider may have changed
      // since the thumbnail was created).
      const thumbObject = await this.prisma.storageObject.findUnique({
        where: { storageKey: key },
        select: { storageProvider: true, bucket: true },
      });

      if (thumbObject) {
        const provider = await this.resolver.getProviderFor(
          thumbObject.storageProvider,
          thumbObject.bucket,
        );
        return await provider.getSignedDownloadUrl(key);
      }

      // Row not yet created (thumbnail still in-flight) — fall back to the
      // legacy static provider to preserve existing behaviour.
      return await this.storageProvider.getSignedDownloadUrl(key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to sign thumbnail URL for key ${key}: ${msg}`);
      return null;
    }
  }

  /**
   * Explore: aggregate media by place (locality or place name).
   * Groups non-deleted geotagged items in the circle by their most specific
   * available geo tier (geoLocality > geoPlaceName), returning up to 50
   * places ordered by item count descending with a cover thumbnail.
   */
  async explorePlaces(
    circleId: string,
    userId: string,
    userPermissions: string[],
  ): Promise<Array<{ name: string; count: number; coverThumbnailUrl: string | null }>> {
    await this.circleMembershipService.assertCircleAccess(userId, circleId, userPermissions, 'viewer' as CircleRole);

    // Fetch all geotagged items with the fields we need (no pagination — we aggregate)
    const items = await this.prisma.mediaItem.findMany({
      where: {
        circleId,
        deletedAt: null,
        archivedAt: null,
        OR: [
          { geoLocality: { not: null } },
          { geoPlaceName: { not: null } },
        ],
      },
      select: {
        geoLocality: true,
        geoPlaceName: true,
        metadata: true,
      },
    });

    // Group by most specific geo tier
    const placeMap = new Map<
      string,
      { count: number; coverMetadata: Prisma.JsonValue | null }
    >();

    for (const item of items) {
      const name = item.geoLocality ?? item.geoPlaceName;
      if (!name) continue;

      const existing = placeMap.get(name);
      if (existing) {
        existing.count += 1;
      } else {
        placeMap.set(name, { count: 1, coverMetadata: item.metadata });
      }
    }

    // Sort by count desc, cap at 50
    const sorted = Array.from(placeMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 50);

    // Sign cover thumbnails in parallel
    return Promise.all(
      sorted.map(async ([name, { count, coverMetadata }]) => ({
        name,
        count,
        coverThumbnailUrl: await this.signThumb(coverMetadata),
      })),
    );
  }

  /**
   * Explore: list tags in the circle with item counts and a cover thumbnail.
   * Returns up to 50 tags ordered by count descending.
   */
  async exploreTags(
    circleId: string,
    userId: string,
    userPermissions: string[],
  ): Promise<Array<{ name: string; count: number; coverThumbnailUrl: string | null }>> {
    await this.circleMembershipService.assertCircleAccess(userId, circleId, userPermissions, 'viewer' as CircleRole);

    // Fetch tags with count and one cover media item's metadata
    const tags = await this.prisma.tag.findMany({
      where: { circleId },
      include: {
        _count: {
          select: { mediaTags: true },
        },
        mediaTags: {
          take: 1,
          include: {
            mediaItem: {
              select: { metadata: true, deletedAt: true, archivedAt: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    // Sort by count desc, cap at 50
    const sorted = tags
      .filter((t) => t._count.mediaTags > 0)
      .sort((a, b) => b._count.mediaTags - a._count.mediaTags)
      .slice(0, 50);

    // Sign cover thumbnails in parallel
    return Promise.all(
      sorted.map(async (tag) => {
        const coverMedia = tag.mediaTags[0]?.mediaItem;
        const coverMeta =
          coverMedia && !coverMedia.deletedAt && !coverMedia.archivedAt ? coverMedia.metadata : null;
        return {
          name: tag.name,
          count: tag._count.mediaTags,
          coverThumbnailUrl: await this.signThumb(coverMeta),
        };
      }),
    );
  }

  /**
   * Fetch an Album and enforce ownership/any-permission.
   */
  async getAlbumWithOwnershipCheck(
    id: string,
    userId: string,
    userPermissions: string[],
    required: CircleRole,
  ) {
    const album = await this.prisma.album.findUnique({ where: { id } });

    if (!album) {
      throw new NotFoundException(`Album with id ${id} not found`);
    }

    await this.circleMembershipService.assertCircleAccess(userId, album.circleId, userPermissions, required);

    return album;
  }

  // ---------------------------------------------------------------------------
  // Facets
  // ---------------------------------------------------------------------------

  /**
   * Return the distinct geo hierarchy (Country → Region → Locality) present in
   * a circle's non-deleted, geocoded media items.
   *
   * Built via a single Prisma groupBy over the four geo columns so no extra
   * round-trips are needed.  Results are folded into a nested structure in
   * application code and sorted by count descending at every level.
   *
   * Response shape:
   *   Array<{
   *     country: string;
   *     countryCode: string | null;
   *     count: number;            // total items for this country
   *     regions: Array<{
   *       name: string;
   *       count: number;
   *       localities: Array<{ name: string; count: number }>;
   *     }>;
   *   }>
   */
  async facetsLocations(
    circleId: string,
    userId: string,
    userPermissions: string[],
  ): Promise<
    Array<{
      country: string;
      countryCode: string | null;
      count: number;
      regions: Array<{
        name: string;
        count: number;
        localities: Array<{ name: string; count: number }>;
      }>;
    }>
  > {
    await this.circleMembershipService.assertCircleAccess(
      userId,
      circleId,
      userPermissions,
      'viewer' as CircleRole,
    );

    const rows = await this.prisma.mediaItem.groupBy({
      by: ['geoCountry', 'geoCountryCode', 'geoAdmin1', 'geoLocality'],
      where: {
        circleId,
        deletedAt: null,
        geoCountry: { not: null },
      },
      _count: { _all: true },
    });

    type LocalityEntry = { name: string; count: number };
    type RegionEntry = { name: string; count: number; localities: LocalityEntry[] };
    type CountryEntry = {
      country: string;
      countryCode: string | null;
      count: number;
      regions: RegionEntry[];
    };

    const countryMap = new Map<string, CountryEntry>();

    for (const row of rows) {
      const country = row.geoCountry as string; // filtered NOT NULL above
      const countryCode = (row.geoCountryCode as string | null) ?? null;
      const region = (row.geoAdmin1 as string | null) ?? null;
      const locality = (row.geoLocality as string | null) ?? null;
      const count = row._count._all;

      let countryEntry = countryMap.get(country);
      if (!countryEntry) {
        countryEntry = { country, countryCode, count: 0, regions: [] };
        countryMap.set(country, countryEntry);
      }
      countryEntry.count += count;

      if (region) {
        let regionEntry = countryEntry.regions.find((r) => r.name === region);
        if (!regionEntry) {
          regionEntry = { name: region, count: 0, localities: [] };
          countryEntry.regions.push(regionEntry);
        }
        regionEntry.count += count;

        if (locality) {
          let localityEntry = regionEntry.localities.find((l) => l.name === locality);
          if (!localityEntry) {
            localityEntry = { name: locality, count: 0 };
            regionEntry.localities.push(localityEntry);
          }
          localityEntry.count += count;
        }
      }
    }

    // Sort all levels by count descending
    const result = Array.from(countryMap.values());
    result.sort((a, b) => b.count - a.count);
    for (const country of result) {
      country.regions.sort((a, b) => b.count - a.count);
      for (const region of country.regions) {
        region.localities.sort((a, b) => b.count - a.count);
      }
    }

    return result;
  }
}

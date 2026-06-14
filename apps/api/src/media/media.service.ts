import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CircleRole } from '@prisma/client';
import { FastifyReply } from 'fastify';
import { stringify as csvStringify } from 'csv-stringify';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSIONS } from '../common/constants/roles.constants';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../storage/providers/storage-provider.interface';
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
import { MediaMetadataSyncService } from './sync/media-metadata-sync.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { GEO_LOCATION_PROVIDER, GeoLocationProvider } from './geo/geo-location-provider.interface';

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
          classification: dto.classification ?? 'unreviewed',
          title: dto.title ?? null,
          caption: dto.caption ?? null,
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
      classification,
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
    } = query;

    const skip = (page - 1) * pageSize;

    await this.circleMembershipService.assertCircleAccess(userId, circleId, userPermissions, 'viewer' as CircleRole);

    const where: Prisma.MediaItemWhereInput = {
      circleId,
      // Exclude soft-deleted items
      deletedAt: null,
      // Optional filters
      ...(type && { type }),
      ...(classification && { classification }),
      ...(favorite !== undefined && { favorite }),
      ...(contentHash && { contentHash }),
      // Date range
      ...(capturedAtFrom || capturedAtTo
        ? {
            capturedAt: {
              ...(capturedAtFrom && { gte: capturedAtFrom }),
              ...(capturedAtTo && { lte: capturedAtTo }),
            },
          }
        : {}),
      // Album filter — join via AlbumItem
      ...(albumId
        ? {
            albumItems: {
              some: { albumId },
            },
          }
        : {}),
      // Tag filter — join via MediaTag → Tag.name
      ...(tag
        ? {
            mediaTags: {
              some: {
                tag: {
                  name: { equals: tag, mode: 'insensitive' },
                },
              },
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
      ...(cameraMake ? { cameraMake: { contains: cameraMake, mode: 'insensitive' as const } } : {}),
      ...(cameraModel ? { cameraModel: { contains: cameraModel, mode: 'insensitive' as const } } : {}),
      ...(sourceDeviceName ? { sourceDeviceName: { contains: sourceDeviceName, mode: 'insensitive' as const } } : {}),
      ...(sourceDeviceId ? { sourceDeviceId } : {}),
      ...(missingGeo === true ? { takenLat: null, takenLng: null } : {}),
      ...(missingGeo === false ? { takenLat: { not: null }, takenLng: { not: null } } : {}),
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
      // Exclude soft-deleted items
      deletedAt: null,
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
    const item = await this.prisma.mediaItem.findUnique({ where: { id } });

    if (!item || item.deletedAt !== null) {
      throw new NotFoundException(`MediaItem with id ${id} not found`);
    }

    await this.circleMembershipService.assertCircleAccess(userId, item.circleId, userPermissions, 'viewer' as CircleRole);

    // Fetch only the storageKey of the linked StorageObject to avoid spreading
    // a BigInt `size` field into the response.
    const storageObj = await this.prisma.storageObject.findUnique({
      where: { id: item.storageObjectId },
      select: { storageKey: true },
    });

    const [thumbnailUrl, downloadUrl] = await Promise.all([
      this.signThumb(item.metadata),
      storageObj
        ? this.storageProvider.getSignedDownloadUrl(storageObj.storageKey)
        : Promise.resolve(null),
    ]);

    return {
      ...item,
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
        ...(dto.classification !== undefined && {
          classification: dto.classification,
        }),
        ...(dto.metadata !== undefined && {
          metadata:
            dto.metadata !== null
              ? (dto.metadata as Prisma.InputJsonValue)
              : Prisma.JsonNull,
        }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.caption !== undefined && { caption: dto.caption }),
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

    const result: Array<{ tagId: string; name: string }> = [];

    for (const name of dto.names) {
      // Upsert Tag (idempotent per circleId + name unique constraint)
      const tag = await this.prisma.tag.upsert({
        where: { circleId_name: { circleId: item.circleId, name } },
        create: { addedById: userId, circleId: item.circleId, name },
        update: {},
      });

      // Upsert MediaTag join (idempotent)
      await this.prisma.mediaTag.upsert({
        where: { tagId_mediaItemId: { tagId: tag.id, mediaItemId: item.id } },
        create: { tagId: tag.id, mediaItemId: item.id },
        update: {},
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
    });

    if (!mediaTag) {
      throw new NotFoundException(
        `Tag ${tagId} is not attached to media item ${mediaItemId}`,
      );
    }

    await this.prisma.mediaTag.delete({
      where: { tagId_mediaItemId: { tagId, mediaItemId } },
    });

    this.logger.log(`Removed tag ${tagId} from MediaItem ${mediaItemId}`);
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
      classification: string;
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
      classification: item.classification,
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
        'classification',
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
            classification: record.classification,
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

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
      return await this.storageProvider.getSignedDownloadUrl(key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to sign thumbnail URL for key ${key}: ${msg}`);
      return null;
    }
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
}

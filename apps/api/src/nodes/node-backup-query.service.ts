// =============================================================================
// NodeBackupQueryService (issue #310, epic #308 — Local Media Backup via Worker Nodes)
// =============================================================================
//
// Pure query layer for the node backup data plane — no HTTP concerns, no
// authorization beyond the owner-scope resolution the caller feeds it. The
// controller layer (a later child of epic #308) calls these methods from the
// PAT/nod_-authenticated /api/nodes/* routes.
//
//   - resolveScope: owner's circle memberships ∩ the config's circleIds
//   - getChanges: (updatedAt, id) keyset page over EVERYTHING sidecar-visible,
//     including trashed (tombstones — the feed reports deletedAt) and archived
//     items, held back by backup.feedSafetyHorizonSeconds so a burst of
//     same-timestamp in-flight writes can never be skipped by the cursor
//   - composeSidecar: the schemaVersion-1 sidecar object — SINGLE source of
//     truth for what a node writes next to each backed-up file
//   - getManifest: id-keyset page of {id, contentHash, updatedAt, deletedAt,
//     archivedAt} for the reconcile pass
//   - getPendingLag: how many items/bytes remain past a cursor
//   - getDimensions: album/person/tag catalogs for sidecar-independent restore
//
// Serialization rule: every BigInt (sizes, byte sums) leaves this service as a
// STRING — never let a raw BigInt escape to JSON (see CLAUDE.md gotchas).

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

/** Hard cap on manifest page size, independent of backup.maxPageSize. */
const MANIFEST_MAX_LIMIT = 1000;

/** Keyset cursor over (updatedAt, id). */
export interface BackupFeedCursor {
  updatedAt: Date;
  id: string;
}

/**
 * Explicit select for a change-feed row. NEVER add `embedding` or
 * `embeddingVec` to the faces select — `embeddingVec` is a Prisma
 * `Unsupported` column and must not appear in any select; `embedding` is a
 * 128-float vector with no sidecar value.
 */
const changeFeedSelect = {
  id: true,
  circleId: true,
  type: true,
  originalFilename: true,
  capturedAt: true,
  capturedAtOffset: true,
  createdAt: true,
  updatedAt: true,
  importedAt: true,
  contentHash: true,
  width: true,
  height: true,
  durationMs: true,
  orientation: true,
  cameraMake: true,
  cameraModel: true,
  description: true,
  favorite: true,
  archivedAt: true,
  deletedAt: true,
  takenLat: true,
  takenLng: true,
  takenAltitude: true,
  coordSource: true,
  geoCountry: true,
  geoCountryCode: true,
  geoAdmin1: true,
  geoAdmin2: true,
  geoLocality: true,
  geoPlaceName: true,
  geoSource: true,
  sourcePath: true,
  sourceDeviceId: true,
  sourceDeviceName: true,
  metadata: true,
  circle: { select: { name: true } },
  storageObject: {
    select: {
      id: true,
      size: true,
      mimeType: true,
      storageKey: true,
      status: true,
    },
  },
  mediaTags: {
    select: {
      source: true,
      tag: { select: { name: true } },
    },
  },
  albumItems: {
    select: {
      album: { select: { id: true, name: true } },
    },
  },
  faces: {
    select: {
      id: true,
      personId: true,
      boundingBox: true,
      confidence: true,
      videoTimestampMs: true,
      manuallyAssigned: true,
      person: { select: { id: true, name: true, favorite: true } },
    },
  },
} satisfies Prisma.MediaItemSelect;

/** A fully-loaded change-feed row, as returned by getChanges. */
export type BackupFeedItem = Prisma.MediaItemGetPayload<{
  select: typeof changeFeedSelect;
}>;

/** The schemaVersion-1 sidecar document. */
export interface BackupSidecar {
  schemaVersion: 1;
  mediaItemId: string;
  circleId: string;
  circleName: string;
  type: string;
  originalFilename: string;
  capturedAt: string | null;
  capturedAtOffset: number | null;
  createdAt: string;
  updatedAt: string;
  importedAt: string;
  contentHash: string | null;
  /** Bytes as a STRING (BigInt-safe). */
  size: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  orientation: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  description: string | null;
  favorite: boolean;
  archivedAt: string | null;
  deletedAt: string | null;
  geo: {
    takenLat: number | null;
    takenLng: number | null;
    takenAltitude: number | null;
    coordSource: string | null;
    country: string | null;
    countryCode: string | null;
    admin1: string | null;
    admin2: string | null;
    locality: string | null;
    placeName: string | null;
    geoSource: string | null;
  };
  tags: Array<{ name: string; source: string }>;
  albums: Array<{ id: string; name: string }>;
  people: Array<{ personId: string; name: string | null; favorite: boolean }>;
  faces: Array<{
    id: string;
    personId: string | null;
    boundingBox: unknown;
    confidence: number | null;
    videoTimestampMs: number | null;
    manuallyAssigned: boolean;
  }>;
  sourcePath: string | null;
  sourceDeviceId: string | null;
  sourceDeviceName: string | null;
  metadata: unknown;
  exportedAt: string;
}

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;

@Injectable()
export class NodeBackupQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // resolveScope
  // ---------------------------------------------------------------------------

  /**
   * The owner's circle memberships, intersected with the config's circleIds
   * when that array is non-empty (empty = ALL circles the owner belongs to).
   */
  async resolveScope(ownerId: string, circleIds: string[]): Promise<string[]> {
    const memberships = await this.prisma.circleMember.findMany({
      where: { userId: ownerId },
      select: { circleId: true },
    });
    const memberCircleIds = memberships.map((m) => m.circleId);

    if (circleIds.length === 0) return memberCircleIds;

    const requested = new Set(circleIds);
    return memberCircleIds.filter((id) => requested.has(id));
  }

  // ---------------------------------------------------------------------------
  // getChanges
  // ---------------------------------------------------------------------------

  /**
   * One keyset page of the change feed, ordered (updatedAt asc, id asc).
   * Includes trashed (tombstones) and archived items. Rows whose updatedAt is
   * within backup.feedSafetyHorizonSeconds of now are withheld so an in-flight
   * same-timestamp write can never be skipped by the cursor.
   */
  async getChanges(
    scope: string[],
    cursor: BackupFeedCursor | null,
    limit: number,
  ): Promise<BackupFeedItem[]> {
    if (scope.length === 0) return [];

    const settings = await this.systemSettings.getSettings();
    const maxPageSize = settings.backup?.maxPageSize ?? 200;
    const horizonSeconds = settings.backup?.feedSafetyHorizonSeconds ?? 5;
    const take = Math.max(1, Math.min(limit, maxPageSize));

    const horizon = new Date(Date.now() - horizonSeconds * 1000);

    return this.prisma.mediaItem.findMany({
      where: {
        circleId: { in: scope },
        updatedAt: { lte: horizon },
        ...(cursor
          ? {
              OR: [
                { updatedAt: { gt: cursor.updatedAt } },
                { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take,
      select: changeFeedSelect,
    });
  }

  // ---------------------------------------------------------------------------
  // composeSidecar
  // ---------------------------------------------------------------------------

  /** Build the schemaVersion-1 sidecar document — single source of truth. */
  composeSidecar(item: BackupFeedItem): BackupSidecar {
    // People derived from the distinct persons across the item's faces.
    const peopleById = new Map<
      string,
      { personId: string; name: string | null; favorite: boolean }
    >();
    for (const face of item.faces) {
      if (face.person && !peopleById.has(face.person.id)) {
        peopleById.set(face.person.id, {
          personId: face.person.id,
          name: face.person.name,
          favorite: face.person.favorite,
        });
      }
    }

    return {
      schemaVersion: 1,
      mediaItemId: item.id,
      circleId: item.circleId,
      circleName: item.circle.name,
      type: item.type,
      originalFilename: item.originalFilename,
      capturedAt: iso(item.capturedAt),
      capturedAtOffset: item.capturedAtOffset,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      importedAt: item.importedAt.toISOString(),
      contentHash: item.contentHash,
      // BigInt → STRING at the DTO boundary (never serialize a raw BigInt).
      size: item.storageObject ? item.storageObject.size.toString() : null,
      mimeType: item.storageObject?.mimeType ?? null,
      width: item.width,
      height: item.height,
      durationMs: item.durationMs,
      orientation: item.orientation,
      cameraMake: item.cameraMake,
      cameraModel: item.cameraModel,
      description: item.description,
      favorite: item.favorite,
      archivedAt: iso(item.archivedAt),
      deletedAt: iso(item.deletedAt),
      geo: {
        takenLat: item.takenLat,
        takenLng: item.takenLng,
        takenAltitude: item.takenAltitude,
        coordSource: item.coordSource,
        country: item.geoCountry,
        countryCode: item.geoCountryCode,
        admin1: item.geoAdmin1,
        admin2: item.geoAdmin2,
        locality: item.geoLocality,
        placeName: item.geoPlaceName,
        geoSource: item.geoSource,
      },
      tags: item.mediaTags.map((mt) => ({
        name: mt.tag.name,
        source: mt.source,
      })),
      albums: item.albumItems.map((ai) => ({
        id: ai.album.id,
        name: ai.album.name,
      })),
      people: [...peopleById.values()],
      faces: item.faces.map((f) => ({
        id: f.id,
        personId: f.personId,
        boundingBox: f.boundingBox,
        confidence: f.confidence,
        videoTimestampMs: f.videoTimestampMs,
        manuallyAssigned: f.manuallyAssigned,
      })),
      sourcePath: item.sourcePath,
      sourceDeviceId: item.sourceDeviceId,
      sourceDeviceName: item.sourceDeviceName,
      metadata: item.metadata ?? {},
      exportedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // getManifest
  // ---------------------------------------------------------------------------

  /**
   * Id-keyset page over ALL non-hard-deleted items in scope (trashed included),
   * ordered id asc — the reconcile pass compares this against the node's local
   * store to find drift the incremental feed missed.
   */
  async getManifest(
    scope: string[],
    afterId: string | null,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      contentHash: string | null;
      updatedAt: Date;
      deletedAt: Date | null;
      archivedAt: Date | null;
    }>
  > {
    if (scope.length === 0) return [];

    const take = Math.max(1, Math.min(limit, MANIFEST_MAX_LIMIT));

    return this.prisma.mediaItem.findMany({
      where: {
        circleId: { in: scope },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        contentHash: true,
        updatedAt: true,
        deletedAt: true,
        archivedAt: true,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // getPendingLag
  // ---------------------------------------------------------------------------

  /**
   * How much work remains past the cursor: item count and total original
   * bytes. Respects the same safety horizon as getChanges so the number
   * matches what the feed will actually serve. Every MediaItem has exactly
   * one StorageObject (storageObjectId is unique), so aggregating over
   * StorageObject filtered by its mediaItem yields both numbers in one query.
   */
  async getPendingLag(
    scope: string[],
    cursor: BackupFeedCursor | null,
  ): Promise<{ items: number; bytes: bigint }> {
    if (scope.length === 0) return { items: 0, bytes: 0n };

    const settings = await this.systemSettings.getSettings();
    const horizonSeconds = settings.backup?.feedSafetyHorizonSeconds ?? 5;
    const horizon = new Date(Date.now() - horizonSeconds * 1000);

    const mediaWhere: Prisma.MediaItemWhereInput = {
      circleId: { in: scope },
      updatedAt: { lte: horizon },
      ...(cursor
        ? {
            OR: [
              { updatedAt: { gt: cursor.updatedAt } },
              { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
            ],
          }
        : {}),
    };

    const agg = await this.prisma.storageObject.aggregate({
      where: { mediaItem: { is: mediaWhere } },
      _count: { _all: true },
      _sum: { size: true },
    });

    return {
      items: agg._count._all,
      bytes: agg._sum.size ?? 0n,
    };
  }

  // ---------------------------------------------------------------------------
  // getDimensions
  // ---------------------------------------------------------------------------

  /**
   * Album / person / tag catalogs across the scope circles, so a node can
   * materialize collection-level structure (e.g. album folders) without
   * re-deriving it from every sidecar.
   */
  async getDimensions(scope: string[]): Promise<{
    albums: Array<{
      id: string;
      name: string;
      description: string | null;
      itemCount: number;
      itemIds: string[];
    }>;
    people: Array<{
      id: string;
      name: string | null;
      favorite: boolean;
      faceCount: number;
    }>;
    tags: Array<{ name: string; itemCount: number }>;
  }> {
    if (scope.length === 0) return { albums: [], people: [], tags: [] };

    const [albums, people, tags] = await Promise.all([
      this.prisma.album.findMany({
        where: { circleId: { in: scope } },
        select: {
          id: true,
          name: true,
          description: true,
          items: { select: { mediaItemId: true } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.person.findMany({
        where: { circleId: { in: scope }, deletedAt: null },
        select: {
          id: true,
          name: true,
          favorite: true,
          _count: { select: { faces: true } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.tag.findMany({
        where: { circleId: { in: scope } },
        select: {
          name: true,
          _count: { select: { mediaTags: true } },
        },
      }),
    ]);

    // Tags are circle-scoped rows; aggregate by name across circles (and
    // across sources — the count is total MediaTag instances per name).
    const tagCounts = new Map<string, number>();
    for (const tag of tags) {
      tagCounts.set(tag.name, (tagCounts.get(tag.name) ?? 0) + tag._count.mediaTags);
    }

    return {
      albums: albums.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        itemCount: a.items.length,
        itemIds: a.items.map((i) => i.mediaItemId),
      })),
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        favorite: p.favorite,
        faceCount: p._count.faces,
      })),
      tags: [...tagCounts.entries()]
        .map(([name, itemCount]) => ({ name, itemCount }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
}

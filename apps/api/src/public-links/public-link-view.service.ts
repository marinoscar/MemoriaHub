// =============================================================================
// What an anonymous link recipient sees of a shared photo, video or album (RETRO-I4, #578)
// =============================================================================
//
// The public view of a platform link grant (`grantee_kind = 'link'`) on a
// `media_item` or an `album`. Called by the two guarded public controllers
// AFTER `LinkGrantGuard` resolved the `X-Link-Token` header, so the link is
// known to be active, unexpired and to reach the `read` action of its record.
//
// THE CONTRACT (unchanged from the `media_shares` era, docs/specs/public-sharing.md):
//   - metadata-stripped: `mediaType` ('photo' | 'video'), `width`, `height` and
//     nothing else about an item. No filename, description, tags, people, dates,
//     location, camera or internal id ever reaches the JSON;
//   - an archived item is served (archive is not a privacy control); a trashed
//     item is a missing record (the type's `loadOwners` already treats a trashed
//     media item as missing, so the guard answers 404 before this runs); an
//     album lists only its non-trashed members, in album order.
//
// WHAT CHANGED: the bytes are no longer proxied through the API. Each item
// carries a short-lived PRESIGNED download URL (`url`, `Content-Disposition:
// inline`) and, when a thumbnail exists, a `thumbnailUrl`, both minted by the
// storage driver recorded on the row (the platform's `StorageProviderRouter`).
// S3/R2 presigned GETs honour `Range`, and the `local` driver's signed route
// (`GET /api/storage/local/objects/:token`) does too, so a video still seeks.
// An `<img src>` cannot send the link header; a presigned URL carries no link
// token, so the token never reaches a log through a media request.
//
// Every database read runs in `LinkGrantsService.withLinkScope`: ONE
// transaction scoped to the link's organization with no user id, so row-level
// security confines it; the `where` limits it to the one record.
// =============================================================================

import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { LinkGrantsService, type ResolvedLinkGrant } from '@marinoscar/platform-api/sharing';

import { StorageProviderResolver } from '../platform/storage/storage-provider.resolver';

/**
 * Lifetime of a public presigned URL. Short (one hour): long enough for a
 * recipient to watch a video and seek in it, short enough that a copied URL
 * stops working soon after; the page re-fetches the view for fresh URLs.
 */
export const PUBLIC_LINK_URL_TTL_SECONDS = 3600;

/** One shared photo or video, as a link recipient sees it. */
export interface PublicLinkMedia {
  mediaType: 'photo' | 'video';
  width: number | null;
  height: number | null;
  /** Presigned GET of the original bytes (inline). `null` when it could not be signed. */
  url: string | null;
  /** Presigned GET of the JPEG thumbnail, or `null` when the item has none. */
  thumbnailUrl: string | null;
}

/** `GET /api/public/links/media`. */
export interface PublicMediaLinkView {
  type: 'media_item';
  expiresAt: string | null;
  media: PublicLinkMedia;
}

/** `GET /api/public/links/album`. */
export interface PublicAlbumLinkView {
  type: 'album';
  expiresAt: string | null;
  itemCount: number;
  items: PublicLinkMedia[];
}

/** The columns a public view needs; nothing else is selected. */
const MEDIA_SELECT = {
  type: true,
  width: true,
  height: true,
  metadata: true,
  storageObject: { select: { storageKey: true, storageProvider: true, bucket: true } },
} as const;

type MediaRow = Prisma.MediaItemGetPayload<{ select: typeof MEDIA_SELECT }>;

/** Where a thumbnail key lives, when its own `storage_objects` row says so. */
type ThumbLocation = { storageProvider: string; bucket: string | null };

/** The thumbnail key the processing pipeline records in an item's metadata. */
export function thumbnailKeyOf(metadata: Prisma.JsonValue | null): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const key = (metadata as Record<string, unknown>)['thumbnailStorageKey'];
  return typeof key === 'string' && key.length > 0 ? key : null;
}

@Injectable()
export class PublicLinkViewService {
  constructor(
    private readonly links: LinkGrantsService,
    private readonly storage: StorageProviderResolver,
  ) {}

  /** The photo or video a `media_item` link opens. */
  async mediaView(link: ResolvedLinkGrant): Promise<PublicMediaLinkView> {
    const { item, thumbs } = await this.links.withLinkScope(link, async (raw) => {
      const tx = raw as Prisma.TransactionClient;
      const row = await tx.mediaItem.findFirst({ where: { id: link.resourceId, deletedAt: null }, select: MEDIA_SELECT });
      return { item: row, thumbs: row ? await this.thumbLocations(tx, [row]) : new Map<string, ThumbLocation>() };
    });
    // The guard checked the record exists; a row trashed in between is the same 404.
    if (!item) throw new NotFoundException('Link not found');
    return { type: 'media_item', expiresAt: iso(link.expiresAt), media: await this.present(item, thumbs) };
  }

  /** The album an `album` link opens: its non-trashed members, in album order. */
  async albumView(link: ResolvedLinkGrant): Promise<PublicAlbumLinkView> {
    const { rows, thumbs } = await this.links.withLinkScope(link, async (raw) => {
      const tx = raw as Prisma.TransactionClient;
      const albumItems = await tx.albumItem.findMany({
        where: { albumId: link.resourceId, mediaItem: { deletedAt: null } },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
        select: { mediaItem: { select: MEDIA_SELECT } },
      });
      const media = albumItems.map((entry) => entry.mediaItem);
      return { rows: media, thumbs: await this.thumbLocations(tx, media) };
    });
    const items: PublicLinkMedia[] = [];
    for (const row of rows) items.push(await this.present(row, thumbs));
    return { type: 'album', expiresAt: iso(link.expiresAt), itemCount: items.length, items };
  }

  /** The recorded location of every thumbnail key of `rows`, in ONE query. */
  private async thumbLocations(tx: Prisma.TransactionClient, rows: readonly MediaRow[]): Promise<Map<string, ThumbLocation>> {
    const keys = [...new Set(rows.map((row) => thumbnailKeyOf(row.metadata)).filter((key): key is string => key !== null))];
    if (keys.length === 0) return new Map();
    const objects = await tx.storageObject.findMany({
      where: { storageKey: { in: keys } },
      select: { storageKey: true, storageProvider: true, bucket: true },
    });
    return new Map(objects.map((o) => [o.storageKey, { storageProvider: o.storageProvider, bucket: o.bucket }]));
  }

  /** Metadata-stripped item plus its presigned URLs. */
  private async present(row: MediaRow, thumbs: ReadonlyMap<string, ThumbLocation>): Promise<PublicLinkMedia> {
    const original = row.storageObject;
    const thumbKey = thumbnailKeyOf(row.metadata);
    // A thumbnail without its own row is written beside its original (same driver and bucket).
    const thumbAt = thumbKey ? thumbs.get(thumbKey) ?? { storageProvider: original.storageProvider, bucket: original.bucket } : null;
    return {
      mediaType: row.type === 'photo' ? 'photo' : 'video',
      width: row.width,
      height: row.height,
      url: original.storageKey ? await this.sign(original.storageProvider, original.bucket, original.storageKey) : null,
      thumbnailUrl: thumbKey && thumbAt ? await this.sign(thumbAt.storageProvider, thumbAt.bucket, thumbKey) : null,
    };
  }

  private async sign(provider: string, bucket: string | null, key: string): Promise<string | null> {
    try {
      const driver = await this.storage.getProviderFor(provider, bucket);
      return await driver.getSignedDownloadUrl(key, {
        expiresIn: PUBLIC_LINK_URL_TTL_SECONDS,
        responseContentDisposition: 'inline',
      });
    } catch {
      // A driver that cannot sign (removed, misconfigured) leaves that one item without a URL.
      return null;
    }
  }
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

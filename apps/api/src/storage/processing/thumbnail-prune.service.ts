import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageProviderResolver } from '../providers/storage-provider.resolver';
import { thumbnailKeyPrefixFor } from './thumbnail-key.util';

/**
 * ThumbnailPruneService (issue #434)
 *
 * Deletes thumbnail objects for a source StorageObject that are no longer the
 * one its `_processing.thumbnail` entry points at — the orphans left behind
 * when versioned thumbnail keys move (see thumbnail-key.util.ts).
 *
 * CALL ORDER MATTERS. This must run only AFTER
 * `MediaMetadataSyncService.syncFromStorageObject` has repointed the MediaItem's
 * `metadata.thumbnailStorageKey` at the new key; otherwise a concurrent gallery
 * request could sign the key we are about to delete and render a broken tile.
 * That is why pruning lives at the destructive call sites (the AI enhancer's
 * replace, the orientation editor, the node persist path) rather than inside
 * ThumbnailProcessor, which runs before that sync.
 *
 * Everything here is BEST-EFFORT: an orphaned thumbnail is a few tens of KB of
 * wasted storage, never a reason to fail a user-facing edit that has already
 * committed. Nothing in this service throws.
 */
@Injectable()
export class ThumbnailPruneService {
  private readonly logger = new Logger(ThumbnailPruneService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
  ) {}

  /**
   * Read the thumbnail key currently recorded on a source object's
   * `metadata._processing.thumbnail.thumbnailStorageKey`, or null.
   */
  private currentThumbnailKey(metadata: Prisma.JsonValue | null): string | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }
    const processing = (metadata as Record<string, unknown>)['_processing'];
    if (!processing || typeof processing !== 'object' || Array.isArray(processing)) {
      return null;
    }
    const thumb = (processing as Record<string, unknown>)['thumbnail'];
    if (!thumb || typeof thumb !== 'object' || Array.isArray(thumb)) {
      return null;
    }
    const key = (thumb as Record<string, unknown>)['thumbnailStorageKey'];
    return typeof key === 'string' && key ? key : null;
  }

  /**
   * Delete every thumbnail object belonging to `sourceObjectId` except the one
   * currently referenced by the source object. Returns how many were pruned.
   *
   * Deliberately a no-op when the source object records no current thumbnail
   * key: without a key to keep, "prune everything else" would mean "prune
   * everything", which would leave the item with no thumbnail at all.
   */
  async pruneSupersededThumbnails(sourceObjectId: string): Promise<number> {
    try {
      const source = await this.prisma.storageObject.findUnique({
        where: { id: sourceObjectId },
        select: { metadata: true },
      });

      const keepKey = this.currentThumbnailKey(source?.metadata ?? null);
      const prefix = thumbnailKeyPrefixFor(sourceObjectId);

      // Sanity: only prune when the key we are keeping is itself one of this
      // object's thumbnails. Anything else means the convention was violated
      // upstream, and deleting by prefix would be guesswork.
      if (!keepKey || !keepKey.startsWith(prefix)) {
        return 0;
      }

      const superseded = await this.prisma.storageObject.findMany({
        where: {
          storageKey: { startsWith: prefix },
          NOT: { storageKey: { equals: keepKey } },
        },
        select: {
          id: true,
          storageKey: true,
          storageProvider: true,
          bucket: true,
        },
      });

      let pruned = 0;
      for (const row of superseded) {
        // Bytes first, then the row: a failed byte delete must not leave a
        // dangling row nothing points at, and a row that outlives its bytes is
        // harmless (signing it 404s exactly as a missing thumbnail already does).
        try {
          const provider = await this.resolver.getProviderFor(
            row.storageProvider,
            row.bucket,
          );
          await provider.delete(row.storageKey);
        } catch (err) {
          this.logger.warn(
            `pruneSupersededThumbnails: failed to delete bytes for ${row.storageKey}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }

        try {
          await this.prisma.storageObject.delete({ where: { id: row.id } });
          pruned++;
        } catch (err) {
          this.logger.warn(
            `pruneSupersededThumbnails: failed to delete StorageObject row ${row.id}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (pruned > 0) {
        this.logger.log(
          `pruneSupersededThumbnails: pruned ${pruned} superseded thumbnail(s) for ` +
            `StorageObject ${sourceObjectId} (kept ${keepKey})`,
        );
      }
      return pruned;
    } catch (err) {
      this.logger.warn(
        `pruneSupersededThumbnails: skipped for StorageObject ${sourceObjectId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }
}

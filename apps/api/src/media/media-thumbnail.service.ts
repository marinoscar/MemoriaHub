import { Injectable, Logger, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { MediaUrlSigningService } from './signing/media-url-signing.service';

/**
 * MediaThumbnailService
 *
 * Extracted signing helper so that non-media modules (e.g. SearchService) can
 * attach signed thumbnail URLs to media items without importing the full
 * MediaService and its heavy dependency tree.
 *
 * Logic is identical to the private `signThumb` method in MediaService:
 *   1. Read `thumbnailStorageKey` from the item's JSONB metadata field.
 *   2. Look up the StorageObject row to find the provider + bucket that holds
 *      the thumbnail (the active provider may have changed since upload).
 *   3. Obtain a signed download URL from that provider.
 *   4. Fall back to the legacy static STORAGE_PROVIDER token when no row exists
 *      (thumbnail is still in-flight or was created before multi-provider support).
 */
@Injectable()
export class MediaThumbnailService {
  private readonly logger = new Logger(MediaThumbnailService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
    private readonly resolver: StorageProviderResolver,
    private readonly urlSigner: MediaUrlSigningService,
  ) {}

  /**
   * Sign a download URL for a thumbnail, or return null if the item has no
   * thumbnail yet (processor has not run / image not yet uploaded).
   */
  async signThumb(metadata: Prisma.JsonValue | null): Promise<string | null> {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }
    const meta = metadata as Record<string, unknown>;
    const key = meta['thumbnailStorageKey'];
    if (typeof key !== 'string' || !key) {
      return null;
    }

    // When the same-origin byte-proxy is enabled, return a signed proxy URL
    // directly — no provider lookup needed (the proxy resolves the provider at
    // serve time). This is the Zscaler-safe path.
    if (this.urlSigner.enabled) {
      return this.urlSigner.signBlobUrl(key);
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
   * Convenience wrapper: enrich an array of items (any shape that carries a
   * `metadata` field) with a signed `thumbnailUrl` field.  Signing is done in
   * parallel for all items in a single call.
   */
  async attachThumbnailUrls<T extends { metadata: Prisma.JsonValue | null }>(
    items: T[],
  ): Promise<(T & { thumbnailUrl: string | null })[]> {
    return Promise.all(
      items.map(async (item) => ({
        ...item,
        thumbnailUrl: await this.signThumb(item.metadata),
      })),
    );
  }
}

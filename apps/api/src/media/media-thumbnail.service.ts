import { Injectable, Logger, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';

/**
 * TTL (seconds) requested when signing a thumbnail download URL. Longer than the
 * provider default of 3600s so a signed URL — and therefore the URL STRING —
 * stays valid across many gallery loads, letting the browser reuse the
 * `Cache-Control: immutable` bytes instead of re-downloading on every request.
 */
const THUMB_URL_TTL_SECONDS = 24 * 3600;

/**
 * Refresh margin (seconds). A cached URL is treated as usable only while it has
 * at least this much validity left, so a URL handed to a client always has
 * meaningful remaining lifetime before its signature expires.
 */
const THUMB_URL_REFRESH_MARGIN_SECONDS = Math.round(THUMB_URL_TTL_SECONDS * 0.1);

/**
 * Hard cap on the in-memory signed-URL cache to prevent unbounded growth on a
 * very large circle. On overflow, expired entries are dropped first, then the
 * oldest ~10% by insertion order (a Map preserves insertion order).
 */
const THUMB_URL_CACHE_MAX_ENTRIES = 50_000;

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

  /**
   * Bounded in-memory cache of signed thumbnail URLs, keyed by
   * `${provider}|${bucket}|${storageKey}` so two providers/buckets that ever
   * hold the same key can't collide. A signed URL for a given key is otherwise
   * provider/bucket-stable, so returning the same URL string within its window
   * lets the browser cache hit instead of re-downloading.
   */
  private readonly signedUrlCache = new Map<
    string,
    { url: string; expiresAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
    private readonly resolver: StorageProviderResolver,
  ) {}

  /**
   * Return a still-valid cached signed URL for a cache key, or null if there is
   * no entry or the entry has fallen inside its refresh margin.
   */
  private getCachedUrl(cacheKey: string): string | null {
    const entry = this.signedUrlCache.get(cacheKey);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.url;
    }
    return null;
  }

  /**
   * Store a freshly-signed URL. `expiresAt` is set to the real signature expiry
   * minus the refresh margin so a returned URL always has meaningful validity
   * left. Enforces the size cap after inserting.
   */
  private storeCachedUrl(cacheKey: string, url: string): void {
    this.signedUrlCache.set(cacheKey, {
      url,
      expiresAt:
        Date.now() +
        (THUMB_URL_TTL_SECONDS - THUMB_URL_REFRESH_MARGIN_SECONDS) * 1000,
    });
    this.evictIfOverCap();
  }

  /**
   * Keep the cache bounded: on overflow drop expired entries first, then, if
   * still over the cap, drop the oldest ~10% by insertion order.
   */
  private evictIfOverCap(): void {
    if (this.signedUrlCache.size <= THUMB_URL_CACHE_MAX_ENTRIES) {
      return;
    }
    const now = Date.now();
    for (const [k, v] of this.signedUrlCache) {
      if (v.expiresAt <= now) {
        this.signedUrlCache.delete(k);
      }
    }
    if (this.signedUrlCache.size <= THUMB_URL_CACHE_MAX_ENTRIES) {
      return;
    }
    const toDrop = Math.ceil(THUMB_URL_CACHE_MAX_ENTRIES * 0.1);
    let dropped = 0;
    for (const k of this.signedUrlCache.keys()) {
      this.signedUrlCache.delete(k);
      if (++dropped >= toDrop) {
        break;
      }
    }
  }

  /**
   * Extract the `thumbnailStorageKey` from an item's JSONB metadata field.
   * Returns null if absent or not a non-empty string. Shared by both the
   * per-item `signThumb` and the batched `signThumbsBatched` paths, and by
   * consuming services that need keys to feed `signThumbsBatched` directly.
   */
  extractThumbKey(metadata: Prisma.JsonValue | null): string | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }
    const key = (metadata as Record<string, unknown>)['thumbnailStorageKey'];
    return typeof key === 'string' && key ? key : null;
  }

  /**
   * Sign a download URL for a thumbnail, or return null if the item has no
   * thumbnail yet (processor has not run / image not yet uploaded).
   */
  async signThumb(metadata: Prisma.JsonValue | null): Promise<string | null> {
    const key = this.extractThumbKey(metadata);
    if (!key) {
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
        const cacheKey = `${thumbObject.storageProvider}|${thumbObject.bucket ?? ''}|${key}`;
        const cached = this.getCachedUrl(cacheKey);
        if (cached) {
          return cached;
        }
        const provider = await this.resolver.getProviderFor(
          thumbObject.storageProvider,
          thumbObject.bucket,
        );
        const url = await provider.getSignedDownloadUrl(key, {
          expiresIn: THUMB_URL_TTL_SECONDS,
        });
        this.storeCachedUrl(cacheKey, url);
        return url;
      }

      // Row not yet created (thumbnail still in-flight) — fall back to the
      // legacy static provider to preserve existing behaviour.
      const fallbackCacheKey = `__static__|${this.storageProvider.getBucket()}|${key}`;
      const fallbackCached = this.getCachedUrl(fallbackCacheKey);
      if (fallbackCached) {
        return fallbackCached;
      }
      const fallbackUrl = await this.storageProvider.getSignedDownloadUrl(key, {
        expiresIn: THUMB_URL_TTL_SECONDS,
      });
      this.storeCachedUrl(fallbackCacheKey, fallbackUrl);
      return fallbackUrl;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to sign thumbnail URL for key ${key}: ${msg}`);
      return null;
    }
  }

  /**
   * Batched thumbnail signing. Given a set of storage keys, resolves all
   * StorageObject rows in a SINGLE `findMany` query, resolves each distinct
   * (provider|bucket) group once, and signs each distinct key once — avoiding
   * the N+1 `findUnique`-per-item pattern of `signThumb`.
   *
   * Returns a Map<key, url|null>. A key with no StorageObject row falls back to
   * the legacy static provider (thumbnail still in-flight); a signing failure
   * logs a warning and maps to null — mirroring `signThumb` exactly.
   */
  async signThumbsBatched(
    keys: string[],
  ): Promise<Map<string, string | null>> {
    const keyToUrl = new Map<string, string | null>();

    // Dedupe keys (drop empties).
    const distinctKeys = new Set<string>();
    for (const key of keys) {
      if (key) distinctKeys.add(key);
    }
    if (distinctKeys.size === 0) {
      return keyToUrl;
    }

    // One query to resolve all storage-object rows for the keys.
    const keyToObject = new Map<
      string,
      { storageProvider: string; bucket: string | null }
    >();
    const objects = await this.prisma.storageObject.findMany({
      where: { storageKey: { in: Array.from(distinctKeys) } },
      select: { storageKey: true, storageProvider: true, bucket: true },
    });
    for (const obj of objects) {
      keyToObject.set(obj.storageKey, {
        storageProvider: obj.storageProvider,
        bucket: obj.bucket,
      });
    }

    // Cache resolved providers by (provider|bucket) so we resolve each once.
    const providerCache = new Map<
      string,
      Awaited<ReturnType<StorageProviderResolver['getProviderFor']>>
    >();

    // Sign each distinct key once, reusing signThumb's resolution + fallback.
    for (const key of distinctKeys) {
      try {
        const obj = keyToObject.get(key);
        if (obj) {
          const urlCacheKey = `${obj.storageProvider}|${obj.bucket ?? ''}|${key}`;
          const cached = this.getCachedUrl(urlCacheKey);
          if (cached) {
            keyToUrl.set(key, cached);
            continue;
          }
          const providerCacheKey = `${obj.storageProvider}|${obj.bucket ?? ''}`;
          let provider = providerCache.get(providerCacheKey);
          if (!provider) {
            provider = await this.resolver.getProviderFor(
              obj.storageProvider,
              obj.bucket,
            );
            providerCache.set(providerCacheKey, provider);
          }
          const url = await provider.getSignedDownloadUrl(key, {
            expiresIn: THUMB_URL_TTL_SECONDS,
          });
          this.storeCachedUrl(urlCacheKey, url);
          keyToUrl.set(key, url);
        } else {
          // Row not yet created — fall back to the legacy static provider.
          const fallbackCacheKey = `__static__|${this.storageProvider.getBucket()}|${key}`;
          const fallbackCached = this.getCachedUrl(fallbackCacheKey);
          if (fallbackCached) {
            keyToUrl.set(key, fallbackCached);
            continue;
          }
          const fallbackUrl = await this.storageProvider.getSignedDownloadUrl(
            key,
            { expiresIn: THUMB_URL_TTL_SECONDS },
          );
          this.storeCachedUrl(fallbackCacheKey, fallbackUrl);
          keyToUrl.set(key, fallbackUrl);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to sign thumbnail URL for key ${key}: ${msg}`);
        keyToUrl.set(key, null);
      }
    }

    return keyToUrl;
  }

  /**
   * Convenience wrapper: enrich an array of items (any shape that carries a
   * `metadata` field) with a signed `thumbnailUrl` field. Signing is batched
   * into a single StorageObject query via `signThumbsBatched`.
   */
  async attachThumbnailUrls<T extends { metadata: Prisma.JsonValue | null }>(
    items: T[],
  ): Promise<(T & { thumbnailUrl: string | null })[]> {
    const itemKeys = items.map((item) => this.extractThumbKey(item.metadata));
    const keyToUrl = await this.signThumbsBatched(
      itemKeys.filter((k): k is string => k !== null),
    );
    return items.map((item, i) => {
      const key = itemKeys[i];
      return {
        ...item,
        thumbnailUrl: key ? keyToUrl.get(key) ?? null : null,
      };
    });
  }
}

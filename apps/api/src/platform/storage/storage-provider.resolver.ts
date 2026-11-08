// =============================================================================
// StorageProviderResolver: MemoriaHub's view of the platform object store (RETRO-D1, #563)
// =============================================================================
//
// Every MemoriaHub feature that moves bytes (media, thumbnails, faces, the
// enhancer, nodes, avatars, media sync, the share byte-proxy, Android releases)
// asks one of two questions, which this service answers from the PLATFORM's
// storage slice:
//
//   getActiveProvider()       where do NEW bytes go?  `STORAGE_PROVIDER` (the
//                             active driver), with its `kind` as the id a row
//                             records in `storage_provider`.
//   getProviderFor(id, bkt)   where do THIS row's bytes live?  The platform's
//                             `StorageProviderRouter`, which builds the driver
//                             recorded on the row (`s3`, `r2`, `local`, ...) with
//                             the row's bucket, so objects written before a
//                             driver switch keep working.
//
// It holds no configuration and no client of its own: it replaced the app's
// `storage/providers/storage-provider.resolver.ts` (which built S3 clients from
// `storage_provider_credentials` and the `S3_*` variables) and keeps its method
// names so the consumers did not change shape.
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  STORAGE_PROVIDER,
  StorageProviderRouter,
  type StorageProvider,
} from '@marinoscar/platform-api/storage';

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class StorageProviderResolver {
  constructor(
    @Inject(STORAGE_PROVIDER) private readonly active: StorageProvider,
    private readonly router: StorageProviderRouter,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The provider new uploads go to, and the id to record on the row.
   *
   * @returns the active driver's client and its `kind` (`s3`, `r2`, `s3compatible`, `local`).
   * @throws StorageNotConfiguredError (503) when no driver is configured.
   */
  async getActiveProvider(): Promise<{ id: string; provider: StorageProvider }> {
    const provider = await this.router.forLocation(null);
    return { id: provider.kind, provider };
  }

  /**
   * The provider of a recorded location: the driver a row names, with the row's bucket.
   * A row with no recorded provider (or one this deployment cannot build) is
   * served by the active driver, exactly as the platform's own objects API does.
   *
   * @param providerId - the row's `storage_provider`.
   * @param bucket - the row's `bucket` (`null` means the driver's current one).
   */
  async getProviderFor(providerId: string | null | undefined, bucket?: string | null): Promise<StorageProvider> {
    return this.router.forLocation(providerId ? { provider: providerId, bucket: bucket ?? '' } : null);
  }

  /**
   * A presigned GET for a storage object's bytes, for SERVER-TRUSTED callers only
   * (the worker-node claim and the node backup feed): it checks no ownership and
   * accepts an object still `processing`. Never expose it on a user route; the
   * objects API's download keeps its owner and status checks. Moved here from the
   * app's former `ObjectsService.getInternalDownloadUrl` (RETRO-D1).
   *
   * @returns the URL, or `null` when the row is missing or has no key.
   */
  async getInternalDownloadUrl(objectId: string, expiresIn?: number): Promise<string | null> {
    const object = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
      select: { storageKey: true, storageProvider: true, bucket: true },
    });
    if (!object || !object.storageKey) return null;
    const provider = await this.getProviderFor(object.storageProvider, object.bucket);
    return provider.getSignedDownloadUrl(object.storageKey, {
      expiresIn: expiresIn ?? this.config.get<number>('storage.signedUrlExpiry', 3600),
    });
  }

  /** The object store bound to `STORAGE_PROVIDER` (resolves the active driver per call). */
  get storageProvider(): StorageProvider {
    return this.active;
  }
}

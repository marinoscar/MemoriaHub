import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { Trace } from '@marinoscar/platform-api/otel-core';
import {
  ObjectProcessorRegistry,
  deleteStorageKeys,
  registerStorageKeyPrefixes,
  storageKeyPrefixRegistry,
  storageObjectSize,
  type ObjectProcessor,
  type StorageProvider,
} from '@marinoscar/platform-api/storage';
import type {
  MemoriahubDeleteManyResult,
  MemoriahubKeyPrefixDef,
  MemoriahubObjectProcessor,
  MemoriahubObjectStore,
  MemoriahubObjectStoreCapabilities,
  MemoriahubObjectStorePort,
  MemoriahubUploadOptions,
  MemoriahubUploadResult,
} from '@marinoscar/memoriahub-api/ports';

import { StorageProviderResolver } from '../../platform/storage/storage-provider.resolver';

// =============================================================================
// PlatformMemoriahubObjectStoreAdapter: the `MEMORIAHUB_OBJECT_STORE` port over the platform storage slice
// (RETRO-J4, #610)
// =============================================================================
//
// `active()` and `forLocation()` are `StorageProviderResolver` (RETRO-D1): `STORAGE_PROVIDER`, the active
// driver, for new bytes, and the platform `StorageProviderRouter` for the driver a row RECORDED (`s3`, `r2`,
// `local`, ...) with the row's bucket, so objects written before a driver switch keep working. Bytes are
// never buffered here: `upload` takes a stream and `download` returns one, and a large read goes through a
// signed URL. `registerProcessor` registers on the platform `ObjectProcessorRegistry`, which runs the
// processors in priority order inside the `storage.object.process` job.
//
// A processor registered here appends to the registry: equal priorities keep REGISTRATION order, so a slice
// registers all of its processors from one place (as `MediaProcessorsRegistrar` does today).
// =============================================================================

/** A platform driver seen through the port. */
class PlatformObjectStore implements MemoriahubObjectStore {
  constructor(private readonly provider: StorageProvider) {}

  get kind(): string {
    return this.provider.kind;
  }

  getBucket(): string {
    return this.provider.getBucket();
  }

  /** The platform driver's contract (RETRO-D1): `partUploadMode: 'proxied'` means the API part route, which needs `uploadPart`. */
  get capabilities(): MemoriahubObjectStoreCapabilities {
    return {
      partUploadMode: this.provider.partUploadMode === 'proxied' ? 'proxied' : 'presigned',
      acceptsPartBytes: typeof this.provider.uploadPart === 'function',
    };
  }

  async upload(key: string, body: Readable, options: MemoriahubUploadOptions): Promise<MemoriahubUploadResult> {
    const result = await this.provider.upload(key, body, {
      mimeType: options.mimeType,
      ...(options.contentLength !== undefined ? { contentLength: options.contentLength } : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
      ...(options.cacheControl !== undefined ? { cacheControl: options.cacheControl } : {}),
    });

    return { key: result.key, bucket: result.bucket, ...(result.eTag !== undefined ? { eTag: result.eTag } : {}) };
  }

  download(key: string): Promise<Readable> {
    return this.provider.download(key);
  }

  getSignedDownloadUrl(
    key: string,
    options?: { expiresIn?: number; responseContentDisposition?: string },
  ): Promise<string> {
    return this.provider.getSignedDownloadUrl(key, options);
  }

  getSignedPutUrl(key: string, options?: { expiresIn?: number; contentType?: string }): Promise<string> {
    return this.provider.getSignedPutUrl(key, options);
  }

  delete(key: string): Promise<void> {
    return this.provider.delete(key);
  }

  async deleteMany(keys: readonly string[]): Promise<MemoriahubDeleteManyResult> {
    return deleteStorageKeys(this.provider, keys);
  }

  exists(key: string): Promise<boolean> {
    return this.provider.exists(key);
  }

  async size(key: string): Promise<number | null> {
    return (await storageObjectSize(this.provider, key)) ?? null;
  }
}

@Injectable()
export class PlatformMemoriahubObjectStoreAdapter implements MemoriahubObjectStorePort {
  constructor(
    private readonly resolver: StorageProviderResolver,
    private readonly processors: ObjectProcessorRegistry,
  ) {}

  @Trace()
  async active(): Promise<{ id: string; store: MemoriahubObjectStore }> {
    const { id, provider } = await this.resolver.getActiveProvider();
    return { id, store: new PlatformObjectStore(provider) };
  }

  @Trace()
  async forLocation(provider: string | null | undefined, bucket?: string | null): Promise<MemoriahubObjectStore> {
    return new PlatformObjectStore(await this.resolver.getProviderFor(provider, bucket));
  }

  @Trace()
  signedUrlForObject(objectId: string, expiresIn?: number): Promise<string | null> {
    return this.resolver.getInternalDownloadUrl(objectId, expiresIn);
  }

  registerKeyPrefixes(defs: readonly MemoriahubKeyPrefixDef[]): void {
    const missing = defs.filter((def) => !storageKeyPrefixRegistry.has(def.id));
    if (missing.length === 0) return;
    registerStorageKeyPrefixes(missing);
  }

  registerProcessor(processor: MemoriahubObjectProcessor): void {
    this.processors.register(processor as unknown as ObjectProcessor);
  }
}

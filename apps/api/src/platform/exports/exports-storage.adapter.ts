// =============================================================================
// The exports slice's STORAGE_PROVIDER: MemoriaHub's own providers (RETRO-H2, #596)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(RETRO-D1): the exports slice writes, signs and deletes its
// files through the platform `STORAGE_PROVIDER`, which resolves the platform `storage`
// settings namespace and credential store. MemoriaHub still runs its own storage stack
// (`src/storage/providers`: s3 / r2 / local, `storage.activeProvider`, the
// `storage_provider_credentials` rows) until the storage slice lands, so the platform
// provider would point at an UNCONFIGURED store and every export would fail. The slice
// has no `target` option (unlike db-backup), so `ExportsHostModule` provides the
// platform's public `STORAGE_PROVIDER` token itself with this adapter: `ExportsModule`
// lists the host module FIRST in its imports and Nest resolves a token from the first
// import that exports it, ahead of the slice's own `StorageProvidersModule`. Scoped to
// the slice: no other module sees this binding. When RETRO-D1 mounts the storage slice,
// delete this file and the provider entry in `exports-host.module.ts`.
//
// WRITES go to the active provider (`storage.activeProvider`); `kind` reports its id
// (`s3`, `r2`, `local`), which the slice records on the `storage_objects` row next to
// the bucket the upload returned. Nothing is buffered: the slice's writer stream is
// handed straight to the provider's streaming `upload`.
//
// READS, SIGNED LINKS AND DELETES resolve the provider RECORDED ON THE ROW
// (`storage_objects.storage_provider` / `bucket`, found by key), never the currently
// active one: an export written before an administrator switched providers must still
// download and expire. A key no row records yet (a partial upload the slice cleans up
// before committing) uses the provider this process wrote it to.
// =============================================================================

import type { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { forSystem } from '@marinoscar/platform-api/core';
import type { StorageProvider as PlatformStorageProvider } from '@marinoscar/platform-api/storage';

import { PrismaService } from '../../prisma/prisma.service';
import type { StorageProvider } from '../../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../../storage/providers/storage-provider.resolver';

type UploadOptions = Parameters<PlatformStorageProvider['upload']>[2];
type UploadResult = Awaited<ReturnType<PlatformStorageProvider['upload']>>;
type SignedUrlOptions = Parameters<PlatformStorageProvider['getSignedDownloadUrl']>[1];

/** Where an export file lives. */
interface Location {
  provider: string;
  bucket: string | null;
}

/** The keys this process uploaded but no row records yet: at most this many are remembered. */
const PENDING_KEYS_MAX = 256;

@Injectable()
export class ExportsStorageAdapter implements PlatformStorageProvider {
  private readonly logger = new Logger(ExportsStorageAdapter.name);

  /** The active provider's id as of the last write (`s3` before the first). */
  private activeId = 's3';
  /** Keys written by this process, by location, until a row records them. */
  private readonly written = new Map<string, Location>();

  constructor(
    private readonly resolver: StorageProviderResolver,
    private readonly prisma: PrismaService,
  ) {}

  /** The id the slice records on the row: the provider the last upload went to. */
  get kind(): string {
    return this.activeId;
  }

  async upload(key: string, stream: Readable, options: UploadOptions): Promise<UploadResult> {
    const active = await this.resolver.getActiveProvider();
    this.activeId = active.id;
    const result = await active.provider.upload(key, stream, {
      mimeType: options.mimeType,
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(options.contentLength !== undefined ? { contentLength: options.contentLength } : {}),
    });
    this.remember(key, { provider: active.id, bucket: result.bucket || null });
    return { key: result.key, bucket: result.bucket, location: result.location, ...(result.eTag ? { eTag: result.eTag } : {}) };
  }

  async getSignedDownloadUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    return (await this.providerFor(key)).getSignedDownloadUrl(key, options);
  }

  async download(key: string): Promise<Readable> {
    return (await this.providerFor(key)).download(key);
  }

  async delete(key: string): Promise<void> {
    await (await this.providerFor(key)).delete(key);
    this.written.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.providerFor(key)).exists(key);
  }

  async getMetadata(key: string): Promise<Record<string, string> | null> {
    return (await this.providerFor(key)).getMetadata(key);
  }

  async setMetadata(key: string, metadata: Record<string, string>): Promise<void> {
    await (await this.providerFor(key)).setMetadata(key, metadata);
  }

  getBucket(): string {
    return '';
  }

  // The exports slice never uploads in parts or presigns a PUT.
  initMultipartUpload(): never {
    throw new Error('Export files are written in one streamed upload');
  }
  getSignedUploadUrl(): never {
    throw new Error('Export files are written in one streamed upload');
  }
  completeMultipartUpload(): never {
    throw new Error('Export files are written in one streamed upload');
  }
  abortMultipartUpload(): never {
    throw new Error('Export files are written in one streamed upload');
  }
  getSignedPutUrl(): never {
    throw new Error('Export files are written in one streamed upload');
  }

  /** The provider recorded on the row of `key`; the one this process wrote it to; else the active one. */
  private async providerFor(key: string): Promise<StorageProvider> {
    const recorded = await this.recordedLocation(key);
    const location = recorded ?? this.written.get(key);
    if (location) return this.resolver.getProviderFor(location.provider, location.bucket);
    this.logger.warn(`No storage object records the export file "${key}"; using the active provider.`);
    return (await this.resolver.getActiveProvider()).provider;
  }

  private async recordedLocation(key: string): Promise<Location | null> {
    // `storage_objects` forces row-level security on `org_id`; the key names the row.
    const system = forSystem(this.prisma, 'export') as unknown as PrismaService;
    const row = (await system.storageObject.findUnique({
      where: { storageKey: key },
      select: { storageProvider: true, bucket: true },
    })) as { storageProvider: string; bucket: string | null } | null;
    if (!row || row.storageProvider === '') return null;
    return { provider: row.storageProvider, bucket: row.bucket === '' ? null : row.bucket };
  }

  private remember(key: string, location: Location): void {
    if (this.written.size >= PENDING_KEYS_MAX) {
      const oldest = this.written.keys().next().value;
      if (oldest !== undefined) this.written.delete(oldest);
    }
    this.written.set(key, location);
  }
}

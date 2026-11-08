import { Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';

import type { AiObjectStore } from '@marinoscar/platform-api/ai';

import { StorageProviderResolver } from '../../storage/providers/storage-provider.resolver';

// =============================================================================
// AI_OBJECT_STORE over MemoriaHub's own storage providers (RETRO-E1, #595)
// =============================================================================
//
// The platform AI slice reads and writes storage objects (image-edit inputs, a
// transcription's recording, generated images and speech under `ai-outputs/`)
// through this port. The platform's own adapter sits over the platform storage
// slice's `STORAGE_PROVIDER`, which MemoriaHub has not mounted yet (RETRO-D1):
// the app still runs its own s3 / r2 / local providers, chosen by
// `storage.activeProvider`. So this port is a thin view over the app's
// `StorageProviderResolver`: writes go to the ACTIVE provider, exactly where a
// new upload goes, and reads, deletes and signed links resolve the same one.
//
// Nothing in MemoriaHub calls the platform's media runs in E1 (the kill switch
// is off by default and no feature is registered until RETRO-E2), so this port
// is bound because the slice requires it, not because a run uses it today.
//
// PLATFORM-ADOPTION-SHIM(RETRO-D1): when the storage slice is mounted, bind the
// platform's adapter over its `STORAGE_PROVIDER` instead and delete this file.
// =============================================================================

/** Where an administrator configures object storage (the remedy a run reports). */
const STORAGE_SETTINGS_PATH = '/admin/settings/storage/providers';

/** Raised when no storage provider can take a write. */
export class AiStorageNotConfiguredError extends Error {
  readonly reason = 'storage_not_configured';
  constructor(cause?: unknown) {
    super('Object storage is not configured', { cause });
    this.name = 'AiStorageNotConfiguredError';
  }
}

@Injectable()
export class AiObjectStoreAdapter implements AiObjectStore {
  readonly settingsPath = STORAGE_SETTINGS_PATH;

  constructor(private readonly resolver: StorageProviderResolver) {}

  private async active() {
    try {
      return await this.resolver.getActiveProvider();
    } catch (err) {
      throw new AiStorageNotConfiguredError(err);
    }
  }

  async upload(
    key: string,
    body: Readable,
    opts: { mimeType: string; contentLength: number },
  ): Promise<{ bucket: string }> {
    const { provider } = await this.active();
    const result = await provider.upload(key, body, {
      mimeType: opts.mimeType,
      contentLength: opts.contentLength,
    });
    return { bucket: result.bucket };
  }

  async delete(key: string): Promise<void> {
    const { provider } = await this.active();
    await provider.delete(key);
  }

  async download(key: string): Promise<Readable> {
    const { provider } = await this.active();
    return provider.download(key);
  }

  async getSignedDownloadUrl(key: string, opts: { expiresIn: number }): Promise<string> {
    const { provider } = await this.active();
    return provider.getSignedDownloadUrl(key, { expiresIn: opts.expiresIn });
  }

  async assertWritable(): Promise<void> {
    await this.active();
  }

  async activeProvider(): Promise<string> {
    return (await this.active()).id;
  }

  notConfiguredReason(err: unknown): string | null {
    return err instanceof AiStorageNotConfiguredError ? err.reason : null;
  }
}

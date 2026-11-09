import { Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';

import type { AiObjectStore } from '@marinoscar/platform-api/ai';
import { StorageProviderRouter, type StorageProvider } from '@marinoscar/platform-api/storage';

// =============================================================================
// AI_OBJECT_STORE over the platform storage slice (RETRO-E1, #595; RETRO-D1, #563)
// =============================================================================
//
// The platform AI slice reads and writes storage objects (image-edit inputs, a
// transcription's recording, generated images and speech under `ai-outputs/`)
// through this port. Since RETRO-D1 it is a thin view over the storage slice's
// active driver (`StorageProviderRouter.forLocation(null)`, resolved per call), exactly where a new
// upload goes; reads, deletes and signed links resolve the same driver, as the
// platform's own reference adapter does. `@marinoscar/platform-api/ai` ships no
// adapter of its own, so the host keeps this small class.
//
// Nothing in MemoriaHub calls the platform's media runs yet (the kill switch is
// off by default and no feature is registered until RETRO-E2), so this port is
// bound because the slice requires it, not because a run uses it today.
// =============================================================================

/** Where an administrator configures object storage (the remedy a run reports). */
const STORAGE_SETTINGS_PATH = '/admin/settings/storage';

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

  constructor(private readonly router: StorageProviderRouter) {}

  private async active(): Promise<{ id: string; provider: StorageProvider }> {
    try {
      // The active driver (`forLocation(null)`), resolved per call: an unconfigured store throws here.
      const provider = await this.router.forLocation(null);
      return { id: provider.kind, provider };
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

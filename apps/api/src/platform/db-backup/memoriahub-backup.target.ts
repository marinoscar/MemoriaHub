// =============================================================================
// The primary backup target: MemoriaHub's own storage providers (RETRO-D4, #580)
// =============================================================================
//
// WHY NOT THE PLATFORM'S DEFAULT TARGET. Since platform 0.1.0-next.28 (EAB
// #1121) the default `StorageProviderBackupTarget` routes reads, deletes and
// signed links through the run's recorded location, which was this class's first
// reason to exist. The one thing it still does not do is WRITE to a provider
// other than the active one: it writes through `STORAGE_PROVIDER`, so its `id` is
// always the active driver and the engine refuses (400) a `databaseBackup.storageProvider`
// pin that names another configured provider. MemoriaHub has always honoured that
// pin (backups on one provider, media on another), so this target stays.
//
// PLATFORM-ADOPTION-SHIM(RETRO-SEAM-STORAGE-3): drop the `target` option of
// `forRoot` (the default adapter then applies) and delete this file once the
// default target writes to the pinned provider. Consequence until then,
// documented by the platform: node offload is withheld for an app target (Open
// decision 2 of #580 keeps it off anyway).
//
// WRITES go to the provider `databaseBackup.storageProvider` pins, else the active
// one (`storage.provider`). `id` is that provider's id (`s3`, `r2`,
// `local`) and `location` its bucket; the engine records both on the run.
//
// READS, DELETES AND SIGNED LINKS resolve the provider RECORDED ON THE RUN
// (`database_backup_runs.storage_provider` / `bucket`: the `BackupObjectLocation`
// the engine passes since next.28, else looked up by the key), never the
// currently active one: an administrator who switched providers must still be
// able to download, restore and delete a backup taken before the switch. That is
// also what keeps the pre-platform archives (`db-backups/...`, carried into
// `database_backup_runs` by `scripts/migrate-db-backup-settings.ts`) reachable.
//
// STREAMING. `openWrite` hands the engine a PassThrough piped into the provider's
// streaming `upload`; nothing is buffered, and a failed upload destroys the
// stream so the dump stops (the engine awaits both `done` and the dump's exit).
// =============================================================================

import { PassThrough, type Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import type {
  BackupObjectLocation,
  BackupSignedUrlOptions,
  BackupSink,
  BackupTarget,
  BackupTargetObject,
  BackupWriteMeta,
} from '@marinoscar/platform-api/db-backup';

import { PrismaService } from '../../prisma/prisma.service';
import { AppSystemSettingsService } from '../settings/app-system-settings.service';
import type { StorageProvider } from '@marinoscar/platform-api/storage';
import { StorageProviderResolver } from '../storage/storage-provider.resolver';

/** A target id must match the platform's `^[a-z][a-z0-9_-]{0,47}$`; anything else falls back to `s3`. */
const TARGET_ID_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;

/** Where a stored archive lives, as recorded on its run. */
interface RecordedLocation {
  provider: string;
  bucket: string | null;
}

@Injectable()
export class MemoriaHubBackupTarget implements BackupTarget {
  private readonly logger = new Logger(MemoriaHubBackupTarget.name);

  /** The provider new archives are written to, as of the last `refresh()`. */
  private currentId: string;
  private current: StorageProvider | null = null;

  constructor(
    private readonly resolver: StorageProviderResolver,
    private readonly prisma: PrismaService,
    private readonly settings: AppSystemSettingsService,
  ) {
    // Until the first `refresh()` (the engine calls it before every run) the id is
    // the platform's default driver; `refresh()` reads the real one.
    this.currentId = 's3';
  }

  /** The id of the provider new archives go to (`s3`, `r2`, `local`). */
  get id(): string {
    return this.currentId;
  }

  /** The bucket of that provider (empty before the first `refresh()`). */
  get location(): string {
    return this.current?.getBucket() ?? '';
  }

  /** Re-reads the pin and the active provider; the engine calls it before every run. */
  async refresh(): Promise<void> {
    const settings = await this.settings.getSettings();
    const pinned = (settings as { databaseBackup?: { storageProvider?: string | null } }).databaseBackup
      ?.storageProvider;
    if (typeof pinned === 'string' && pinned.trim() !== '') {
      this.currentId = normaliseId(pinned.trim());
      this.current = await this.resolver.getProviderFor(this.currentId);
      return;
    }
    const active = await this.resolver.getActiveProvider();
    this.currentId = normaliseId(active.id);
    this.current = active.provider;
  }

  openWrite(key: string, meta: BackupWriteMeta): BackupSink {
    const stream = new PassThrough();
    const done = this.writableProvider()
      .then((provider) =>
        provider.upload(key, stream, {
          mimeType: meta.contentType,
          // No `contentLength`: a streamed dump's size is unknown until its last byte.
          metadata: { ...meta.metadata },
        }),
      )
      .then(() => undefined);
    // A failed upload must tear the writer down, or the dump keeps filling a stream
    // nobody reads. `done` itself still rejects to its awaiter.
    done.catch((error: unknown) => stream.destroy(error instanceof Error ? error : new Error(String(error))));
    return { stream, done };
  }

  async openRead(key: string, location?: BackupObjectLocation): Promise<Readable> {
    return (await this.providerFor(key, location)).download(key);
  }

  async delete(key: string, location?: BackupObjectLocation): Promise<void> {
    await (await this.providerFor(key, location)).delete(key);
  }

  // The app's providers have no listing; nothing in the engine calls it.
  // eslint-disable-next-line require-yield
  async *list(prefix: string): AsyncIterable<BackupTargetObject> {
    throw new Error(
      `MemoriaHub's storage providers cannot list objects, so the backup target cannot list "${prefix}".`,
    );
  }

  async signedDownloadUrl(
    key: string,
    options: BackupSignedUrlOptions,
    location?: BackupObjectLocation,
  ): Promise<string> {
    return (await this.providerFor(key, location)).getSignedDownloadUrl(key, {
      expiresIn: options.expiresInSeconds,
      responseContentDisposition: `attachment; filename="${options.filename}"`,
    });
  }

  /** The provider for a new archive: the one the last refresh chose (refreshing once if none yet). */
  private async writableProvider(): Promise<StorageProvider> {
    if (!this.current) await this.refresh();
    return this.current!;
  }

  /**
   * The provider recorded on the run that owns `key`: the location the engine passed (next.28),
   * else the run found by key; the current one when no run records it.
   */
  private async providerFor(key: string, location?: BackupObjectLocation): Promise<StorageProvider> {
    if (location?.provider) return this.resolver.getProviderFor(location.provider, location.bucket);
    const recorded = await this.recordedLocation(key);
    if (recorded) return this.resolver.getProviderFor(recorded.provider, recorded.bucket);
    this.logger.warn(`No backup run records the archive "${key}"; using the current provider "${this.currentId}".`);
    return this.writableProvider();
  }

  private async recordedLocation(key: string): Promise<RecordedLocation | null> {
    const run = await this.prisma.databaseBackupRun.findFirst({
      where: { storageKey: key },
      select: { storageProvider: true, bucket: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!run || run.storageProvider === '') return null;
    return { provider: run.storageProvider, bucket: run.bucket === '' ? null : run.bucket };
  }
}

function normaliseId(id: string | undefined): string {
  const value = (id ?? '').toLowerCase();
  return TARGET_ID_PATTERN.test(value) ? value : 's3';
}

// =============================================================================
// Picture Enhancement Purge Handler
// =============================================================================
//
// Global enrichment job that reaps orphaned staging previews: for ready/failed
// media_enhancements rows older than pictureEnhancement.retentionHours, it
// deletes the staged enhanced bytes and marks the row `expired`. Applied /
// discarded / already-expired rows are never touched. Mirrors TrashPurgeHandler.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MediaEnhancementStatus } from '@prisma/client';
import {
  JobHandlerRegistry,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../platform/storage/storage-provider.resolver';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

@Injectable()
export class PictureEnhancementPurgeHandler implements JobHandler, OnModuleInit {
  readonly type = 'picture_enhancement_purge';
  readonly label = 'AI picture enhancer purge';
  /** Housekeeping: a read, a few deletes per row. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 600_000, maxAttempts: 2 };
  private readonly logger = new Logger(PictureEnhancementPurgeHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
    private readonly systemSettings: AppSystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(_job: Job): Promise<void> {
    // Fallback mirrors settings.schema.ts / DEFAULT_SYSTEM_SETTINGS (168h = 7d).
    const retentionHours =
      (await this.systemSettings.getSettingValue<number>(
        'pictureEnhancement.retentionHours',
      )) ?? 168;

    const cutoff = new Date(Date.now() - retentionHours * 3_600_000);

    this.logger.log(
      `picture_enhancement_purge: starting — retentionHours=${retentionHours}, cutoff=${cutoff.toISOString()}`,
    );

    const rows = await this.prisma.mediaEnhancement.findMany({
      where: {
        status: { in: [MediaEnhancementStatus.ready, MediaEnhancementStatus.failed] },
        updatedAt: { lt: cutoff },
      },
    });

    if (rows.length === 0) {
      this.logger.log('picture_enhancement_purge: nothing past retention cutoff; done');
      return;
    }

    let expired = 0;
    for (const row of rows) {
      // Best-effort delete of every staged object the row owns: the
      // full-resolution result AND its thumbnail derivative (issue #203). Both
      // live on the same provider/bucket, so one resolve covers them; each
      // delete is independent so a failure on one still attempts the other.
      const stagedKeys = [row.stagingStorageKey, row.stagingThumbnailKey].filter(
        (k): k is string => !!k,
      );
      if (stagedKeys.length > 0 && row.stagingProvider) {
        try {
          const provider = await this.resolver.getProviderFor(
            row.stagingProvider,
            row.stagingBucket,
          );
          for (const key of stagedKeys) {
            try {
              await provider.delete(key);
            } catch (err) {
              this.logger.warn(
                `picture_enhancement_purge: failed to delete staging ${key} (non-fatal): ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        } catch (err) {
          this.logger.warn(
            `picture_enhancement_purge: failed to resolve provider ${row.stagingProvider} (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      await this.prisma.mediaEnhancement.update({
        where: { id: row.id },
        data: {
          status: MediaEnhancementStatus.expired,
          stagingStorageKey: null,
          stagingThumbnailKey: null,
        },
      });
      expired += 1;
    }

    this.logger.log(
      `picture_enhancement_purge: expired ${expired} of ${rows.length} candidate row(s)`,
    );
  }
}

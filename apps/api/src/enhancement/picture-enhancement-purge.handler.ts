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
import { EnrichmentJob, MediaEnhancementStatus } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

@Injectable()
export class PictureEnhancementPurgeHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'picture_enhancement_purge';
  private readonly logger = new Logger(PictureEnhancementPurgeHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(_job: EnrichmentJob): Promise<void> {
    const retentionHours =
      (await this.systemSettings.getSettingValue<number>(
        'pictureEnhancement.retentionHours',
      )) ?? 72;

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
      // Best-effort delete of the staged bytes.
      if (row.stagingStorageKey && row.stagingProvider) {
        try {
          const provider = await this.resolver.getProviderFor(
            row.stagingProvider,
            row.stagingBucket,
          );
          await provider.delete(row.stagingStorageKey);
        } catch (err) {
          this.logger.warn(
            `picture_enhancement_purge: failed to delete staging ${row.stagingStorageKey} (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      await this.prisma.mediaEnhancement.update({
        where: { id: row.id },
        data: { status: MediaEnhancementStatus.expired, stagingStorageKey: null },
      });
      expired += 1;
    }

    this.logger.log(
      `picture_enhancement_purge: expired ${expired} of ${rows.length} candidate row(s)`,
    );
  }
}

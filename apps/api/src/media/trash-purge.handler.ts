// =============================================================================
// Trash Purge Enrichment Handler
// =============================================================================
//
// Global enrichment job that hard-deletes trashed media items (deletedAt IS NOT
// NULL) that are older than the configured retentionDays. Runs via the shared
// enrichment worker queue so it benefits from retries, visibility in /admin/jobs,
// and the dedup guarantee of (type, mediaItemId IS NULL).
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { MediaService } from './media.service';

@Injectable()
export class TrashPurgeHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'trash_purge';

  private readonly logger = new Logger(TrashPurgeHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly mediaService: MediaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(_job: EnrichmentJob): Promise<void> {
    const retentionDays =
      (await this.systemSettings.getSettingValue<number>(
        'storage.trash.retentionDays',
      )) ?? 30;

    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

    this.logger.log(
      `trash_purge: starting — retentionDays=${retentionDays}, cutoff=${cutoff.toISOString()}`,
    );

    // Find all trashed items older than the cutoff across ALL circles
    const items = await this.prisma.mediaItem.findMany({
      where: { deletedAt: { not: null, lt: cutoff } },
      select: { id: true },
    });

    if (items.length === 0) {
      this.logger.log('trash_purge: no items past retention cutoff; done');
      return;
    }

    const ids = items.map((i) => i.id);
    const { deleted: purged } = await this.mediaService.purgeMediaItemsBatched(ids);

    this.logger.log(
      `trash_purge: purged ${purged} of ${ids.length} items past cutoff`,
    );
  }
}

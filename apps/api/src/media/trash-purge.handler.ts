// =============================================================================
// Trash Purge Enrichment Handler
// =============================================================================
//
// Global job that hard-deletes trashed media items (deletedAt IS NOT NULL) that
// are older than the configured retentionDays. Runs on the platform queue so it
// benefits from retries, visibility in /admin/jobs, and the dedup of a global
// job (one pending/running row per type).
//
// A native platform `JobHandler` (RETRO-C7, #604). SERVER-ONLY: no node-result
// pair, because purging needs the storage credentials a worker node never
// holds. It stays a plain handler, not a platform retention policy: the window
// is `storage.trash.retentionDays`, a product setting users see on the Trash
// page, and the hourly `trash-purge.task.ts` (RETRO-C9) enqueues it.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type JobExecutionProfile, type JobHandler } from '@marinoscar/platform-api/jobs';
import { PrismaService } from '../prisma/prisma.service';
import { MediaService } from './media.service';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

@Injectable()
export class TrashPurgeHandler implements JobHandler, OnModuleInit {
  readonly type = 'trash_purge';

  readonly label = 'Trash purge';

  /** Every circle's expired trash in one pass: 30 minutes, two attempts. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 1_800_000, maxAttempts: 2 };

  private readonly logger = new Logger(TrashPurgeHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly mediaService: MediaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
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

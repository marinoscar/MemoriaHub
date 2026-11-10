// =============================================================================
// Trash Purge Job Handler
// =============================================================================
//
// Global job that hard-deletes trashed media items (deletedAt IS NOT NULL) that
// are older than the configured retentionDays. Runs on the queue so it benefits
// from retries, visibility in /admin/jobs, and the dedup of a global job (one
// pending/running row per type).
//
// SERVER-ONLY: no node-result pair, because purging needs the storage
// credentials a worker node never holds. The window is
// `storage.trash.retentionDays`, a product setting users see on the Trash page,
// and the hourly `trash-purge.task.ts` enqueues it.
//
// The job type string `trash_purge` is permanent.
// =============================================================================

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import type { MediaDb } from '../data/media-db.js';
import { MEDIA_ITEM_PURGER, type MediaItemPurger } from './media-item-purger.js';

/** The days a trashed item is kept when the setting is absent. */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * Hard-deletes trashed media items past `storage.trash.retentionDays`.
 *
 * @stability experimental
 */
@Injectable()
export class TrashPurgeHandler implements MemoriahubJobHandler, OnModuleInit {
  /** The job type. Permanent. */
  readonly type = 'trash_purge';

  /** The label in the admin job list. */
  readonly label = 'Trash purge';

  /** Every library's expired trash in one pass: 30 minutes, two attempts. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 1_800_000, maxAttempts: 2 };

  private readonly logger = new Logger(TrashPurgeHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MediaDb,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    @Inject(MEDIA_ITEM_PURGER) private readonly purger: MediaItemPurger,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /** Runs one attempt. */
  async process(): Promise<void> {
    const { value: storage } = await this.settings.readSystem<{ trash?: { retentionDays?: number } } | undefined>('storage');
    const retentionDays = storage?.trash?.retentionDays ?? DEFAULT_RETENTION_DAYS;

    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

    this.logger.log(`trash_purge: starting — retentionDays=${retentionDays}, cutoff=${cutoff.toISOString()}`);

    // Find all trashed items older than the cutoff across ALL owner scopes
    const items = await this.prisma.mediaItem.findMany({
      where: { deletedAt: { not: null, lt: cutoff } },
      select: { id: true },
    });

    if (items.length === 0) {
      this.logger.log('trash_purge: no items past retention cutoff; done');
      return;
    }

    const ids = items.map((i: { id: string }) => i.id);
    const { deleted: purged } = await this.purger.purgeMediaItemsBatched(ids);

    this.logger.log(`trash_purge: purged ${purged} of ${ids.length} items past cutoff`);
  }
}

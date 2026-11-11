// =============================================================================
// Picture Enhancement Purge Handler
// =============================================================================
//
// Global enrichment job that reaps orphaned staging previews: for ready/failed
// media_enhancements rows older than pictureEnhancement.retentionHours, it
// deletes the staged enhanced bytes and marks the row `expired`. Applied /
// discarded / already-expired rows are never touched. Mirrors TrashPurgeHandler.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_OBJECT_STORE,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
  type MemoriahubObjectStorePort,
  type MemoriahubSettingsPort,
} from '../ports/index.js';
import { ENHANCEMENT_JOB_TYPES, ENHANCEMENT_STATUS } from './constants.js';
import type { EnhancementDb } from './data/enhancement-db.js';

/**
 * The `picture_enhancement_purge` job handler: reaps staged previews past the retention cutoff.
 *
 * @stability experimental
 */
@Injectable()
export class PictureEnhancementPurgeHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = ENHANCEMENT_JOB_TYPES.purge;
  readonly label = 'AI picture enhancer purge';
  /** Housekeeping: a read, a few deletes per row. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 600_000, maxAttempts: 2 };
  private readonly logger = new Logger(PictureEnhancementPurgeHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: EnhancementDb,
    @Inject(MEMORIAHUB_OBJECT_STORE) private readonly resolver: MemoriahubObjectStorePort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly systemSettings: MemoriahubSettingsPort,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  /**
   * Expires the staged previews past the retention cutoff.
   *
   * @param _job - the housekeeping job (it carries no payload).
   */
  async process(_job: MemoriahubJob): Promise<void> {
    // Fallback mirrors settings.schema.ts / DEFAULT_SYSTEM_SETTINGS (168h = 7d).
    const retentionHours =
      (await this.systemSettings.readSystem<{ retentionHours?: number } | undefined>('pictureEnhancement')).value
        ?.retentionHours ?? 168;

    const cutoff = new Date(Date.now() - retentionHours * 3_600_000);

    this.logger.log(
      `picture_enhancement_purge: starting — retentionHours=${retentionHours}, cutoff=${cutoff.toISOString()}`,
    );

    const rows = await this.prisma.mediaEnhancement.findMany({
      where: {
        status: { in: [ENHANCEMENT_STATUS.ready, ENHANCEMENT_STATUS.failed] },
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
          const provider = await this.resolver.forLocation(
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
          status: ENHANCEMENT_STATUS.expired,
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

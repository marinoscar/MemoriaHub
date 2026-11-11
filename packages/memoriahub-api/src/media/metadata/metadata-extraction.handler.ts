import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { metadataExtractionResultSchema } from '@marinoscar/memoriahub-compute/dto';

import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_PRISMA,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
} from '../../ports/index.js';
import type { MediaDb } from '../data/media-db.js';
import { resolveMediaItemJob } from '../jobs/enrichment-jobs.js';
import { withMediaRateLimits } from '../jobs/media-item-job.js';
import { MetadataExtractionService } from './metadata-extraction.service.js';

/**
 * `metadata_extraction`: re-runs the exif / dimensions / geocode / video-probe extraction for one
 * media item and syncs the typed columns directly. It does NOT emit the post-upload processed
 * event, so tagging, face and burst detection are not re-triggered.
 *
 * NODE-ELIGIBLE: a node submits `{ exif, probe }` (the shared DTO; image dimensions ride inside
 * `exif`). `persistNodeResult` recomputes nothing the node did; it adds the geocode entry
 * server-side from the exif GPS, because that needs the server's configured geo provider (with its
 * credential), and writes the `storage_objects` metadata in the job's organization.
 *
 * @stability experimental
 */
@Injectable()
export class MetadataExtractionHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = 'metadata_extraction';
  readonly label = 'Metadata extraction';
  /** One download (a video streams to a temp file) and one exif/ffprobe pass. */
  readonly profile: MemoriahubJobProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };
  readonly nodeResultSchema = metadataExtractionResultSchema;

  private readonly logger = new Logger(MetadataExtractionHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MediaDb,
    private readonly metadataExtractionService: MetadataExtractionService,
  ) {}

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: MemoriahubJob): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await withMediaRateLimits(() =>
      this.metadataExtractionService.processMediaItem(context, (fn) => this.jobs.runInJobScope(job, fn)),
    );
  }

  /** Persist a node-computed result (already validated by the data plane; re-parsed to narrow). */
  async persistNodeResult(job: MemoriahubJob, result: unknown): Promise<void> {
    const parsed = metadataExtractionResultSchema.parse(result);
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await withMediaRateLimits(() =>
      this.metadataExtractionService.persistMetadata(
        context,
        { exif: parsed.exif, probe: parsed.probe },
        (fn) => this.jobs.runInJobScope(job, fn),
      ),
    );
  }
}

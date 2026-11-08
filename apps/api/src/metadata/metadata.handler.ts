import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  JobHandlerRegistry,
  JobScope,
  type Job,
  type JobExecutionProfile,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { metadataExtractionResultSchema } from '@memoriahub/enrichment-compute/dto';
import { jobWriteScope, resolveMediaItemJob, withPlatformRateLimits } from '../platform/jobs/media-item-job';
import { PrismaService } from '../prisma/prisma.service';
import { MetadataExtractionService } from './metadata.service';

/**
 * `metadata_extraction`: a native platform `JobHandler` (RETRO-C3, #585).
 *
 * Re-runs the exif / dimensions / geocode / video-probe extraction for one media
 * item and syncs the typed columns directly. It does NOT emit
 * `OBJECT_PROCESSED_EVENT`, so tagging, face and burst detection are not
 * re-triggered.
 *
 * NODE-ELIGIBLE: a node submits `{ exif, probe }` (the shared DTO; image
 * dimensions ride inside `exif`). `persistNodeResult` recomputes nothing the node
 * did; it adds the geocode entry server-side from the exif GPS, because that needs
 * the server's configured geo provider (with its credential), and writes the
 * `storage_objects` metadata in the job's organization (`JobScope`).
 */
@Injectable()
export class MetadataExtractionHandler implements JobHandler, OnModuleInit {
  readonly type = 'metadata_extraction';
  readonly label = 'Metadata extraction';
  /** One download (a video streams to a temp file) and one exif/ffprobe pass. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };
  readonly nodeResultSchema = metadataExtractionResultSchema;

  private readonly logger = new Logger(MetadataExtractionHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly jobScope: JobScope,
    private readonly prisma: PrismaService,
    private readonly metadataExtractionService: MetadataExtractionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await withPlatformRateLimits(() =>
      this.metadataExtractionService.processMediaItem(context, jobWriteScope(this.jobScope, job)),
    );
  }

  /** Persist a node-computed result (already validated by the data plane; re-parsed to narrow). */
  async persistNodeResult(job: Job, result: unknown): Promise<void> {
    const parsed = metadataExtractionResultSchema.parse(result);
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await withPlatformRateLimits(() =>
      this.metadataExtractionService.persistMetadata(
        context,
        { exif: parsed.exif, probe: parsed.probe },
        jobWriteScope(this.jobScope, job),
      ),
    );
  }
}

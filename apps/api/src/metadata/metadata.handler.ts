import { Injectable, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob } from '@prisma/client';
import { metadataExtractionResultSchema } from '@memoriahub/enrichment-compute/dto';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { MetadataExtractionService } from './metadata.service';

@Injectable()
export class MetadataExtractionHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'metadata_extraction';

  /**
   * Node-eligibility (distributed workers): the payload a node submits via
   * POST /api/nodes/:id/jobs/:jobId/result for this job type — the shared
   * contract from @memoriahub/enrichment-compute/dto. `{ exif, probe }`,
   * where the image-side dimensions ride inside `exif` as width/height and
   * `probe` is the video-probe entry (null for photos). Geocode is NOT part
   * of the node contract — it runs server-side in persistMetadata, since it
   * needs the server's configured geo provider credentials.
   */
  readonly nodeResultSchema = metadataExtractionResultSchema;

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly metadataExtractionService: MetadataExtractionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    await this.metadataExtractionService.processMediaItem(job);
  }

  /**
   * Persist a node-computed metadata_extraction result (already validated
   * against nodeResultSchema by the ingestion endpoint; re-parsed here for
   * type narrowing). The server-side persist half additionally runs reverse
   * geocoding from the exif GPS fields before syncing typed columns.
   */
  async persistNodeResult(job: EnrichmentJob, result: unknown): Promise<void> {
    const parsed = metadataExtractionResultSchema.parse(result);
    await this.metadataExtractionService.persistMetadata(job, {
      exif: parsed.exif,
      probe: parsed.probe,
    });
  }
}

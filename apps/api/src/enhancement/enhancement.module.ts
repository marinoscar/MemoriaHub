import { Module } from '@nestjs/common';
import {
  AdminEnhancementController,
  ENHANCEMENT_IMAGE_TOOLS,
  ENHANCEMENT_KEY_STATUS,
  ENHANCEMENT_STORAGE_ORG,
  EnhancementBatchesController,
  EnhancementModule as PackagedEnhancementModule,
  MediaEnhancementController,
} from '@marinoscar/memoriahub-api/enhancement';
import { MEDIA_OBJECT_REPROCESSOR, MEDIA_THUMBNAIL_PRUNER } from '@marinoscar/memoriahub-api/media';

import { AiPortModule } from '../ai-port/ai-port.module';
import { DefaultOrgId } from '../common/tenancy/default-org-id';
import { MediaModule } from '../media/media.module';
import { ObjectReprocessService } from '../media-processing/recovery/object-reprocess.service';
import { ThumbnailPruneService } from '../media-processing/thumbnail-prune.service';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { configuredWorkerMode } from '../platform/jobs/legacy-env';
import { ENRICHMENT_RATELIMIT_MAX_HITS } from '../platform/jobs/queue-limits';
import { EnhancementImageToolsAdapter, EnhancementKeyStatusAdapter } from './enhancement-host.adapters';

const packagedEnhancement = PackagedEnhancementModule.forRoot({
  providers: [
    EnhancementImageToolsAdapter,
    EnhancementKeyStatusAdapter,
    { provide: ENHANCEMENT_IMAGE_TOOLS, useExisting: EnhancementImageToolsAdapter },
    { provide: ENHANCEMENT_KEY_STATUS, useExisting: EnhancementKeyStatusAdapter },
    { provide: ENHANCEMENT_STORAGE_ORG, useExisting: DefaultOrgId },
    // The post-upload processing the keep-both and replace paths re-run (the media slice's hooks).
    { provide: MEDIA_OBJECT_REPROCESSOR, useExisting: ObjectReprocessService },
    { provide: MEDIA_THUMBNAIL_PRUNER, useExisting: ThumbnailPruneService },
  ],
  // The media module provides the location-aware `MediaMetadataSyncService`; the processing module the two
  // services the hooks above bind; the AI port module the deployment key source.
  imports: [MediaModule, MediaProcessingModule, AiPortModule],
  rateLimitMaxHits: ENRICHMENT_RATELIMIT_MAX_HITS,
  // Only worker instances create and sweep staging objects.
  housekeepingEnabled: () => configuredWorkerMode() !== 'off',
});

/**
 * The web app's binding of the enhancement slice (RETRO-J10, #624). The AI Picture Enhancer (the service, the
 * server-only `picture_enhancement` job, the purge job and its cron) lives in
 * `@marinoscar/memoriahub-api/enhancement`; this module mounts the three controllers and binds the hooks: the
 * native image libraries (sharp, ExifTool, which stay here), the deployment key status, the organization of a
 * derived storage row and the media slice's post-upload processing hooks.
 */
@Module({
  imports: [packagedEnhancement],
  controllers: [MediaEnhancementController, EnhancementBatchesController, AdminEnhancementController],
  exports: [packagedEnhancement],
})
export class EnhancementModule {}

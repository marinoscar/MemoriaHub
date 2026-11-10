import { Module } from '@nestjs/common';
import { CredentialsModule } from '../platform/credentials/credentials.config';
import { FaceSettingsController } from './face-settings.controller';
import { FaceSettingsService } from './face-settings.service';
import { FaceProviderRegistry } from './providers/face-provider.registry';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { FaceDetectionService } from './face-detection.service';
import { FaceDetectionController } from './face-detection.controller';
import { FaceMatchingService } from './face-matching.service';
import { FaceClusteringService } from './face-clustering.service';
import { PeopleService } from './people.service';
import { PeopleController } from './people.controller';
import { FaceDetectionHandler } from './face-detection.handler';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { FaceBackfillService } from './face-backfill.service';
import { AdminFaceBackfillController } from './admin-face-backfill.controller';
import { FaceDetectionCore } from './face-detection-core.service';
import { VideoFrameExtractionService } from './video-frame-extraction.service';
import { VideoFaceDetectionService } from './video-face-detection.service';
import { VideoFaceDetectionHandler } from './video-face-detection.handler';
import { FaceAutoArchiveSweepHandler } from './face-auto-archive-sweep.handler';
import { MediaModule } from '../media/media.module';
import { MediaTouchModule } from '@marinoscar/memoriahub-api/media';
import { ProfileModule } from '../profile/profile.module';
import { FaceUploadEnrichment } from './face-upload-enrichment';

/**
 * ProfileModule is imported for issue #354: PeopleService propagates a person's
 * profile-picture change to any account linked to that person, and carries the
 * link over on merge. The edge points FaceModule -> ProfileModule; ProfileModule
 * imports only MediaProcessingModule / OwnerAccessModule / so no
 * cycle is closed and no forwardRef is needed.
 */
@Module({
  imports: [CredentialsModule, MediaProcessingModule, OwnerAccessModule, EnrichmentModule, MediaModule, MediaTouchModule, ProfileModule],
  controllers: [FaceSettingsController, FaceDetectionController, PeopleController, AdminFaceBackfillController],
  providers: [
    // Registers this slice's upload fan-out with the media slice (RETRO-J5).
    FaceUploadEnrichment,
    FaceSettingsService,
    FaceProviderRegistry,
    FaceDetectionCore,
    FaceDetectionService,
    FaceMatchingService,
    FaceClusteringService,
    PeopleService,
    FaceDetectionHandler,
    FaceBackfillService,
    VideoFrameExtractionService,
    VideoFaceDetectionService,
    VideoFaceDetectionHandler,
    FaceAutoArchiveSweepHandler,
  ],
  exports: [FaceSettingsService, FaceProviderRegistry, FaceMatchingService, FaceClusteringService, VideoFrameExtractionService, PeopleService],
})
export class FaceModule {}

import { Module } from '@nestjs/common';
import { FaceSettingsController } from './face-settings.controller';
import { FaceSettingsService } from './face-settings.service';
import { FaceProviderRegistry } from './providers/face-provider.registry';
import { SettingsModule } from '../settings/settings.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { CirclesModule } from '../circles/circles.module';
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
import { MediaModule } from '../media/media.module';

@Module({
  imports: [SettingsModule, StorageProvidersModule, CirclesModule, EnrichmentModule, MediaModule],
  controllers: [FaceSettingsController, FaceDetectionController, PeopleController, AdminFaceBackfillController],
  providers: [
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
  ],
  exports: [FaceSettingsService, FaceProviderRegistry, FaceMatchingService, FaceClusteringService, VideoFrameExtractionService],
})
export class FaceModule {}

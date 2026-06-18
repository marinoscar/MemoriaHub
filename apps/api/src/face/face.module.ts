import { Module } from '@nestjs/common';
import { FaceSettingsController } from './face-settings.controller';
import { FaceSettingsService } from './face-settings.service';
import { FaceProviderRegistry } from './providers/face-provider.registry';
import { SettingsModule } from '../settings/settings.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { CirclesModule } from '../circles/circles.module';
import { FaceEnqueueListener } from './processing/face-enqueue.listener';
import { FaceDetectionService } from './face-detection.service';
import { FaceDetectionController } from './face-detection.controller';
import { FaceMatchingService } from './face-matching.service';
import { FaceClusteringService } from './face-clustering.service';
import { PeopleService } from './people.service';
import { PeopleController } from './people.controller';
import { FaceDetectionHandler } from './face-detection.handler';
import { EnrichmentModule } from '../enrichment/enrichment.module';

@Module({
  imports: [SettingsModule, StorageProvidersModule, CirclesModule, EnrichmentModule],
  controllers: [FaceSettingsController, FaceDetectionController, PeopleController],
  providers: [
    FaceSettingsService,
    FaceProviderRegistry,
    FaceEnqueueListener,
    FaceDetectionService,
    FaceMatchingService,
    FaceClusteringService,
    PeopleService,
    FaceDetectionHandler,
  ],
  exports: [FaceSettingsService, FaceProviderRegistry, FaceMatchingService, FaceClusteringService],
})
export class FaceModule {}

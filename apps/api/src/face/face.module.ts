import { Module } from '@nestjs/common';
import { FaceSettingsController } from './face-settings.controller';
import { FaceSettingsService } from './face-settings.service';
import { FaceProviderRegistry } from './providers/face-provider.registry';
import { SettingsModule } from '../settings/settings.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { CirclesModule } from '../circles/circles.module';
import { FaceEnqueueListener } from './processing/face-enqueue.listener';
import { FaceJobWorker } from './processing/face-job.worker';
import { FaceDetectionService } from './face-detection.service';
import { FaceDetectionController } from './face-detection.controller';

@Module({
  imports: [SettingsModule, StorageProvidersModule, CirclesModule],
  controllers: [FaceSettingsController, FaceDetectionController],
  providers: [
    FaceSettingsService,
    FaceProviderRegistry,
    FaceEnqueueListener,
    FaceJobWorker,
    FaceDetectionService,
  ],
  exports: [FaceSettingsService, FaceProviderRegistry],
})
export class FaceModule {}

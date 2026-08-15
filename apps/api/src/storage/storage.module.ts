import { Module } from '@nestjs/common';
import { StorageProvidersModule } from './providers/storage-providers.module';
import { ObjectProcessingModule } from './processing/object-processing.module';
import { CommonModule } from '../common/common.module';
import { CirclesModule } from '../circles/circles.module';
import { ObjectsController } from './objects/objects.controller';
import { ObjectsService } from './objects/objects.service';
import { StorageCleanupTask } from './tasks/storage-cleanup.task';
import { StorageProcessingRecoveryService } from './tasks/storage-processing-recovery.service';
import { StorageProcessingRecoveryTask } from './tasks/storage-processing-recovery.task';
import { ThumbnailPruneService } from './processing/thumbnail-prune.service';

@Module({
  imports: [
    StorageProvidersModule,
    ObjectProcessingModule,
    CommonModule,
    CirclesModule,
  ],
  controllers: [ObjectsController],
  providers: [
    ObjectsService,
    StorageCleanupTask,
    StorageProcessingRecoveryService,
    StorageProcessingRecoveryTask,
    // Exported so the two destructive-overwrite call sites (MediaModule's
    // orientation editor + node thumbnail persist, EnhancementModule's replace)
    // can prune superseded thumbnail keys — see thumbnail-prune.service.ts.
    ThumbnailPruneService,
  ],
  exports: [ObjectsService, StorageProcessingRecoveryService, ThumbnailPruneService],
})
export class StorageModule {}

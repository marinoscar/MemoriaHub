import { Module } from '@nestjs/common';
import { StorageProvidersModule } from './providers/storage-providers.module';
import { ObjectProcessingModule } from './processing/object-processing.module';
import { CommonModule } from '../common/common.module';
import { CirclesModule } from '../circles/circles.module';
import { MediaModule } from '../media/media.module';
import { ObjectsController } from './objects/objects.controller';
import { ObjectsService } from './objects/objects.service';
import { StorageCleanupTask } from './tasks/storage-cleanup.task';
import { StorageProcessingStuckResetTask } from './tasks/storage-processing-stuck-reset.task';

/**
 * MediaModule is imported so StorageProcessingStuckResetTask can inject
 * MediaReprocessService (its exported recovery path) to heal OOM-orphaned
 * storage objects. This does not create a cycle: MediaModule's import graph
 * never pulls in StorageModule (only AppModule imports StorageModule).
 */
@Module({
  imports: [
    StorageProvidersModule,
    ObjectProcessingModule,
    CommonModule,
    CirclesModule,
    MediaModule,
  ],
  controllers: [ObjectsController],
  providers: [ObjectsService, StorageCleanupTask, StorageProcessingStuckResetTask],
  exports: [ObjectsService],
})
export class StorageModule {}

import { Module } from '@nestjs/common';
import { StorageProvidersModule } from './providers/storage-providers.module';
import { ObjectProcessingModule } from './processing/object-processing.module';
import { CommonModule } from '../common/common.module';
import { CirclesModule } from '../circles/circles.module';
import { ObjectsController } from './objects/objects.controller';
import { ObjectsService } from './objects/objects.service';
import { StorageCleanupTask } from './tasks/storage-cleanup.task';

@Module({
  imports: [
    StorageProvidersModule,
    ObjectProcessingModule,
    CommonModule,
    CirclesModule,
  ],
  controllers: [ObjectsController],
  providers: [ObjectsService, StorageCleanupTask],
  exports: [ObjectsService],
})
export class StorageModule {}

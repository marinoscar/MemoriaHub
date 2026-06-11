import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaMetadataSyncService } from './sync/media-metadata-sync.service';

/**
 * MediaModule
 *
 * Imports StorageProvidersModule so that STORAGE_PROVIDER resolves inside
 * MediaService (used to sign fresh thumbnail and download URLs at read time).
 *
 * Circular-dependency note:
 *   StorageProvidersModule only provides S3StorageProvider — it has no
 *   dependency on MediaModule — so there is no cycle.
 */
@Module({
  imports: [PrismaModule, StorageProvidersModule],
  controllers: [MediaController],
  providers: [MediaService, MediaMetadataSyncService],
  exports: [MediaService],
})
export class MediaModule {}

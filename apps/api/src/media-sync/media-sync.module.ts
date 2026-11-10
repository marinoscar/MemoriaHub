import { Module } from '@nestjs/common';

import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { MediaSyncController } from './media-sync.controller';
import { MediaModule as MediaCoreModule } from '@marinoscar/memoriahub-api/media';
import { MediaSyncDeviceSourceBinder } from './media-sync.device-source';

/**
 * Android Media Sync device API (epic #498, issue #505): `/api/media-sync`
 * under `media:read` / `media:write`. `OwnerAccessModule` supplies the per-circle
 * role check for the target circle; `PrismaService` comes from the global
 * `PrismaModule`.
 */
@Module({
  imports: [OwnerAccessModule, MediaCoreModule.forRoot()],
  controllers: [MediaSyncController],
  providers: [MediaSyncDeviceSourceBinder],
  exports: [MediaCoreModule.forRoot()],
})
export class MediaSyncModule {}

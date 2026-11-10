import { Module } from '@nestjs/common';

import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { MediaModule as MediaCoreModule, MediaSyncController } from '@marinoscar/memoriahub-api/media';
import { MediaSyncDeviceSourceBinder } from './media-sync.device-source';

/**
 * Android Media Sync (epic #498, issue #505). The `/api/media-sync` controller, its DTOs and the
 * device service live in `@marinoscar/memoriahub-api/media` (RETRO-J5); this module binds them to the
 * host (the android-app device source) and re-exports the packaged slice.
 */
@Module({
  imports: [OwnerAccessModule, MediaCoreModule.forRoot()],
  controllers: [MediaSyncController],
  providers: [MediaSyncDeviceSourceBinder],
  exports: [MediaCoreModule.forRoot()],
})
export class MediaSyncModule {}

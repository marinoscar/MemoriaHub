import { Module } from '@nestjs/common';

import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { MediaSyncController } from './media-sync.controller';
import { MediaSyncService } from './media-sync.service';
import { MediaSyncDeviceSourceBinder } from './media-sync.device-source';

/**
 * Android Media Sync device API (epic #498, issue #505): `/api/media-sync`
 * under `media:read` / `media:write`. `OwnerAccessModule` supplies the per-circle
 * role check for the target circle; `PrismaService` comes from the global
 * `PrismaModule`.
 */
@Module({
  imports: [OwnerAccessModule],
  controllers: [MediaSyncController],
  providers: [MediaSyncService, MediaSyncDeviceSourceBinder],
  exports: [MediaSyncService],
})
export class MediaSyncModule {}

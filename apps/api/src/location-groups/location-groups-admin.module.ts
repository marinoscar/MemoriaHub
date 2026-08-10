import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { MediaModule } from '../media/media.module';
import { LocationGroupsModule } from './location-groups.module';
import { LocationGroupsService } from './location-groups.service';
import { LocationGroupsController } from './location-groups.controller';
import { LocationGroupsAdminController } from './location-groups-admin.controller';

/**
 * LocationGroupsAdminModule (issue #374) — the management HTTP surface.
 *
 * DELIBERATELY SEPARATE from `LocationGroupsModule`, which must keep importing
 * nothing beyond Prisma/Settings/Enrichment: `MediaModule` already imports
 * `LocationGroupsModule` (for the resolver on its write paths), so putting a
 * `MediaModule` import — needed here for `MediaThumbnailService`, which signs
 * group cover thumbnails — inside `LocationGroupsModule` would close a cycle.
 *
 * This is the `NotificationsReconcileModule` precedent: the leaf module stays
 * import-light and a second module hosts the consumers that need heavier
 * dependencies. Edge direction is one-way throughout:
 *
 *   LocationGroupsAdminModule → MediaModule → LocationGroupsModule
 *
 * No forwardRef anywhere.
 */
@Module({
  imports: [PrismaModule, SettingsModule, MediaModule, LocationGroupsModule],
  controllers: [LocationGroupsController, LocationGroupsAdminController],
  providers: [LocationGroupsService],
  exports: [LocationGroupsService],
})
export class LocationGroupsAdminModule {}

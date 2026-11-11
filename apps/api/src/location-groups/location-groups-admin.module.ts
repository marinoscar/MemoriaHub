import { Module } from '@nestjs/common';
import { LocationGroupsAdminController, LocationGroupsController } from '@marinoscar/memoriahub-api/location';

import { LocationGroupsModule } from './location-groups.module';

/**
 * LocationGroupsAdminModule (issue #374) — the management HTTP surface. The service and the two controllers
 * live in the location slice (`@marinoscar/memoriahub-api/location`, RETRO-J10 #624); this module mounts them.
 */
@Module({
  imports: [LocationGroupsModule],
  controllers: [LocationGroupsController, LocationGroupsAdminController],
})
export class LocationGroupsAdminModule {}

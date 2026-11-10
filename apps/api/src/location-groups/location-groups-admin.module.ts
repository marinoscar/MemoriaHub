import { Module } from '@nestjs/common';

import { LocationGroupsModule } from './location-groups.module';
import { LocationGroupsController } from './location-groups.controller';
import { LocationGroupsAdminController } from './location-groups-admin.controller';

/**
 * LocationGroupsAdminModule (issue #374) — the management HTTP surface. The service lives in the
 * location slice (`@marinoscar/memoriahub-api/location`); the controllers stay here until the
 * identity-backed guard lands in the package.
 */
@Module({
  imports: [LocationGroupsModule],
  controllers: [LocationGroupsController, LocationGroupsAdminController],
})
export class LocationGroupsAdminModule {}

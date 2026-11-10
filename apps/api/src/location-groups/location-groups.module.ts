import { Module } from '@nestjs/common';
import { LocationModule } from '@marinoscar/memoriahub-api/location';

/**
 * LocationGroupsModule (issue #373; the slice moved into `@marinoscar/memoriahub-api/location` by RETRO-J10, #624)
 *
 * Exports LocationGroupResolverService, THE single component that computes canonical location
 * names, the rebuild enqueue helper and the management service. Every write path that touches a
 * `geoCanonical*` column imports this module.
 */
@Module({
  imports: [LocationModule.forRoot()],
  exports: [LocationModule],
})
export class LocationGroupsModule {}

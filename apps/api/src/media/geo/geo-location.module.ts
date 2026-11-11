import { Module } from '@nestjs/common';
import { LocationModule } from '@marinoscar/memoriahub-api/location';

/**
 * GeoLocationModule: the host's name for the geo half of the location slice (RETRO-J10, #624).
 *
 * The reverse providers (offline GeoNames, Nominatim, Google), `GeoLocationService`, the
 * `GEO_LOCATION_PROVIDER` token (the active provider, resolved on every call from the `geo` system settings),
 * the forward place search, the geo administration and the `geocode` job live in
 * `@marinoscar/memoriahub-api/location`. This module re-exports the slice so the host modules that need a geo
 * provider keep importing one module. The slice reads the `geo` settings and the Google key through the
 * settings and secrets ports.
 */
@Module({
  imports: [LocationModule.forRoot()],
  exports: [LocationModule.forRoot()],
})
export class GeoLocationModule {}

import { Module } from '@nestjs/common';
import {
  GeoSettingsController,
  GeocodeAdminController,
  GeocodeMediaController,
} from '@marinoscar/memoriahub-api/location';

import { GeoLocationModule } from '../media/geo/geo-location.module';

/**
 * GeoModule: mounts the geo controllers (RETRO-J10, #624).
 *
 * The geo settings and Google key administration, the `geocode` job with its per-job key broker, the geocode
 * backfill and the controllers' classes live in `@marinoscar/memoriahub-api/location`; the slice is imported
 * through {@link GeoLocationModule}, which this module re-exports (the Doctor check injects
 * `GeoSettingsService` through it).
 */
@Module({
  imports: [GeoLocationModule],
  controllers: [GeoSettingsController, GeocodeAdminController, GeocodeMediaController],
  exports: [GeoLocationModule],
})
export class GeoModule {}

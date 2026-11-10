import { Module, type DynamicModule } from '@nestjs/common';

import { MediaModule } from '../media/index.js';
import { LocationGroupRebuildHandler } from './groups/location-group-rebuild.handler.js';
import { LocationGroupRebuildService } from './groups/location-group-rebuild.service.js';
import { LocationGroupResolverService } from './groups/location-group-resolver.service.js';
import { LocationGroupsService } from './groups/location-groups.service.js';

/**
 * Options of {@link LocationModule.forRoot}. None yet: the slice reads the `locationGrouping`
 * settings namespace and the `LOCATION_GROUPING_ENABLED` kill switch through the settings port.
 *
 * @stability experimental
 */
export interface LocationModuleOptions {
  /** Reserved for the geo providers and the grouping options the rest of the slice brings. */
  readonly reserved?: never;
}

/**
 * The location slice (RETRO-J10, #624). This first cut carries location grouping: the resolver that
 * is the one writer of canonical place names, the set-based `location_group_rebuild` job and its
 * enqueue helper, and the management service behind `/api/location-groups`. It reaches the outside
 * only through the host ports and imports the media slice for cover thumbnails.
 *
 * Import it ONCE in the host and re-export it from the host's own location module.
 *
 * @stability experimental
 */
@Module({})
export class LocationModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module (cached, so every call names the same instance).
   *
   * @param _options - reserved.
   */
  static forRoot(_options: LocationModuleOptions = {}): DynamicModule {
    LocationModule.root ??= {
      module: LocationModule,
      imports: [MediaModule.forRoot()],
      providers: [LocationGroupResolverService, LocationGroupRebuildService, LocationGroupRebuildHandler, LocationGroupsService],
      exports: [LocationGroupResolverService, LocationGroupRebuildService, LocationGroupsService],
    };
    return LocationModule.root;
  }
}

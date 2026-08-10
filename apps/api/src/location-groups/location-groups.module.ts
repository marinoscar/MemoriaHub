import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { LocationGroupResolverService } from './location-group-resolver.service';
import { LocationGroupRebuildService } from './location-group-rebuild.service';
import { LocationGroupRebuildHandler } from './location-group-rebuild.handler';

/**
 * LocationGroupsModule (issue #373)
 *
 * Exports LocationGroupResolverService — THE single component that computes
 * canonical location names — plus the rebuild enqueue helper. Every write path
 * that touches a `geoCanonical*` column imports this module.
 *
 * Cycle-free by construction: EnrichmentModule imports only PrismaModule +
 * SettingsModule, and neither of those (nor this module) imports MediaModule /
 * GeoModule / LocationInferenceModule / WorkflowsModule — the four consumers.
 */
@Module({
  imports: [PrismaModule, SettingsModule, EnrichmentModule],
  providers: [
    LocationGroupResolverService,
    LocationGroupRebuildService,
    LocationGroupRebuildHandler,
  ],
  exports: [LocationGroupResolverService, LocationGroupRebuildService],
})
export class LocationGroupsModule {}

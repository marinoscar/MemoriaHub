import { Module } from '@nestjs/common';
import { StorageSettingsController } from './storage-settings.controller';
import { StorageSettingsService } from './storage-settings.service';
import { StorageMigrationHandler } from './storage-migration.handler';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { SettingsModule } from '../settings/settings.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';

@Module({
  imports: [
    // Provides StorageProviderResolver (+ S3/LocalDisk providers + SystemSettingsService)
    StorageProvidersModule,
    // Provides SystemSettingsService (also re-exported by StorageProvidersModule,
    // but importing directly makes the dependency explicit)
    SettingsModule,
    // Provides EnrichmentJobService + EnrichmentHandlerRegistry
    // (registry is exported by EnrichmentModule; handler self-registers in onModuleInit)
    EnrichmentModule,
  ],
  controllers: [StorageSettingsController],
  providers: [StorageSettingsService, StorageMigrationHandler],
  exports: [StorageSettingsService],
})
export class StorageSettingsModule {}

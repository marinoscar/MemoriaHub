import { Module } from '@nestjs/common';
import { StorageSettingsController } from './storage-settings.controller';
import { StorageSettingsService } from './storage-settings.service';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    // Provides StorageProviderResolver (+ S3/LocalDisk providers + SystemSettingsService)
    StorageProvidersModule,
    // Provides SystemSettingsService (also re-exported by StorageProvidersModule,
    // but importing directly makes the dependency explicit)
    SettingsModule,
  ],
  controllers: [StorageSettingsController],
  providers: [StorageSettingsService],
  exports: [StorageSettingsService],
})
export class StorageSettingsModule {}

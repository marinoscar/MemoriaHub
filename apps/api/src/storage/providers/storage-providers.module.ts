import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { STORAGE_PROVIDER } from './storage-provider.interface';
import { S3StorageProvider } from './s3/s3-storage.provider';
import { LocalDiskStorageProvider } from './local/local-disk.provider';
import { StorageProviderResolver } from './storage-provider.resolver';
import { SettingsModule } from '../../settings/settings.module';

/**
 * Storage Providers Module
 * Provides dependency injection for storage provider implementations.
 *
 * The legacy STORAGE_PROVIDER token is kept for backward compatibility with
 * BackupService and any other callers that inject it directly.  The active
 * provider is still selected at startup via the STORAGE_PROVIDER env var:
 *   STORAGE_PROVIDER=s3    → S3StorageProvider (default)
 *   STORAGE_PROVIDER=local → LocalDiskStorageProvider
 *
 * New uploads and per-object reads/downloads should use StorageProviderResolver
 * instead of STORAGE_PROVIDER so the correct provider is resolved dynamically
 * from system settings (active provider) and from the StorageObject row
 * (per-object provider + bucket recorded at upload time).
 *
 * Both concrete provider classes are always registered so that BackupService
 * can inject LocalDiskStorageProvider directly regardless of the active provider.
 */
@Module({
  imports: [
    // SettingsModule exports SystemSettingsService which StorageProviderResolver
    // needs to read the active provider from system settings.
    SettingsModule,
  ],
  providers: [
    S3StorageProvider,
    LocalDiskStorageProvider,
    StorageProviderResolver,
    {
      provide: STORAGE_PROVIDER,
      useFactory: (
        config: ConfigService,
        s3: S3StorageProvider,
        local: LocalDiskStorageProvider,
      ) => {
        const provider = config.get<string>('storage.provider', 's3');
        return provider === 'local' ? local : s3;
      },
      inject: [ConfigService, S3StorageProvider, LocalDiskStorageProvider],
    },
  ],
  exports: [
    STORAGE_PROVIDER,
    S3StorageProvider,
    LocalDiskStorageProvider,
    StorageProviderResolver,
  ],
})
export class StorageProvidersModule {}

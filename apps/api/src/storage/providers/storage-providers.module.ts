import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { STORAGE_PROVIDER } from './storage-provider.interface';
import { S3StorageProvider } from './s3/s3-storage.provider';
import { LocalDiskStorageProvider } from './local/local-disk.provider';

/**
 * Storage Providers Module
 * Provides dependency injection for storage provider implementations
 *
 * The active provider is selected at startup via the STORAGE_PROVIDER env var:
 *   STORAGE_PROVIDER=s3    → S3StorageProvider (default)
 *   STORAGE_PROVIDER=local → LocalDiskStorageProvider
 *
 * Both provider classes are always registered so that BackupService can inject
 * LocalDiskStorageProvider directly regardless of the active provider.
 */
@Module({
  providers: [
    S3StorageProvider,
    LocalDiskStorageProvider,
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
  exports: [STORAGE_PROVIDER, S3StorageProvider, LocalDiskStorageProvider],
})
export class StorageProvidersModule {}

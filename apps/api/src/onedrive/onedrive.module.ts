import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { AuthModule } from '../auth/auth.module';
import { CirclesModule } from '../circles/circles.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StorageModule } from '../storage/storage.module';
import { MediaModule } from '../media/media.module';
import { OneDriveController } from './onedrive.controller';
import { OneDriveConnectionService } from './onedrive-connection.service';
import { OneDriveImportService } from './onedrive-import.service';
import { OneDriveImportHandler } from './onedrive-import.handler';
import { MicrosoftGraphClient } from './microsoft-graph.client';

/**
 * OneDrive Data Import.
 *
 * Connect slice: Microsoft Graph client, per-user connection (token vault)
 * service, and the OAuth connect endpoints.
 *
 * Import-execution slice: OneDriveImportService (enumerate + fan-out) and
 * OneDriveImportHandler (per-item download → upload → createMedia), driven by
 * the shared enrichment queue.
 *
 * Dependency wiring:
 *   - SettingsModule  → SystemSettingsService (feature gate)
 *   - AuthModule      → AuthService (resolve a userId's permissions in the handler)
 *   - CirclesModule   → CircleMembershipService (per-circle collaborator check)
 *   - EnrichmentModule→ EnrichmentJobService + EnrichmentHandlerRegistry
 *   - StorageModule   → ObjectsService (createObjectFromStream)
 *   - MediaModule     → MediaService (createMedia ingest pipeline)
 *
 * No circular dependency: none of the imported modules import OneDriveModule,
 * so no forwardRef is required.
 */
@Module({
  imports: [
    SettingsModule,
    AuthModule,
    CirclesModule,
    EnrichmentModule,
    StorageModule,
    MediaModule,
  ],
  controllers: [OneDriveController],
  providers: [
    MicrosoftGraphClient,
    OneDriveConnectionService,
    OneDriveImportService,
    OneDriveImportHandler,
  ],
  exports: [MicrosoftGraphClient, OneDriveConnectionService, OneDriveImportService],
})
export class OneDriveModule {}

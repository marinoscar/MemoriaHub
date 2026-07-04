import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { OneDriveController } from './onedrive.controller';
import { OneDriveConnectionService } from './onedrive-connection.service';
import { MicrosoftGraphClient } from './microsoft-graph.client';

/**
 * OneDrive Data Import — connect slice.
 *
 * Registers the Microsoft Graph client, the per-user connection (token vault)
 * service, and the OAuth connect endpoints. PrismaService comes from the global
 * PrismaModule; SettingsModule provides SystemSettingsService for the
 * `features.oneDriveImport` feature gate. ConfigService is globally available.
 *
 * The import run/handler is a later slice and is intentionally not wired here.
 */
@Module({
  imports: [SettingsModule],
  controllers: [OneDriveController],
  providers: [MicrosoftGraphClient, OneDriveConnectionService],
  exports: [MicrosoftGraphClient, OneDriveConnectionService],
})
export class OneDriveModule {}

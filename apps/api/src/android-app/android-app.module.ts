import { Module } from '@nestjs/common';

import { AndroidAppController } from './android-app.controller';
import { AndroidAppService } from './android-app.service';
import { AssetLinksController } from './asset-links.controller';
import { AndroidReleaseAdminController } from './releases/android-release-admin.controller';
import { AndroidReleaseController } from './releases/android-release.controller';
import { AndroidReleaseService } from './releases/android-release.service';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';

// =============================================================================
// AndroidAppModule (issue #503, epic #498)
// =============================================================================
//
// Trust for the Android app's Trusted Web Activity: the admin list of trusted
// (package, signing fingerprint) pairs under `system_settings:*` and the
// public Digital Asset Links document the edge serves at
// `/.well-known/assetlinks.json`.
//
// Imports only `StorageProvidersModule` (for the APK releases, below):
// `PrismaModule` is global, the trusted list is its own
// `system_settings` row read through Prisma (never SystemSettingsService), and
// the audit row is a direct `audit_events` insert. It reads
// `media_sync_devices` (one grouped SELECT) for the apps devices report; it
// does not import the Media Sync module, which owns those writes.
//
// APK RELEASES (#504): `AndroidReleaseAdminController`
// (`/api/admin/android-app/releases`), `AndroidReleaseController`
// (`/api/android-app/releases/*`, `/api/android-app/download/:token`) and
// `AndroidReleaseService`, which calls `AndroidAppService.ensureTrusted` when
// a release becomes current. Storage comes from `StorageProvidersModule` (the
// provider resolver only), NOT the full storage module, so the job queue and
// the object pipeline are not pulled in. `AndroidReleaseService` is exported
// for the Doctor checks (#507), which also land here.
// =============================================================================

@Module({
  imports: [StorageProvidersModule],
  controllers: [AndroidAppController, AssetLinksController, AndroidReleaseAdminController, AndroidReleaseController],
  providers: [AndroidAppService, AndroidReleaseService],
  exports: [AndroidAppService, AndroidReleaseService],
})
export class AndroidAppModule {}

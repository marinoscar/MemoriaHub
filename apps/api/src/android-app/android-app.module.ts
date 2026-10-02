import { Module } from '@nestjs/common';

import { AndroidAppController } from './android-app.controller';
import { AndroidAppService } from './android-app.service';
import { AssetLinksController } from './asset-links.controller';

// =============================================================================
// AndroidAppModule (issue #503, epic #498)
// =============================================================================
//
// Trust for the Android app's Trusted Web Activity: the admin list of trusted
// (package, signing fingerprint) pairs under `system_settings:*` and the
// public Digital Asset Links document the edge serves at
// `/.well-known/assetlinks.json`.
//
// Imports nothing: `PrismaModule` is global, the trusted list is its own
// `system_settings` row read through Prisma (never SystemSettingsService), and
// the audit row is a direct `audit_events` insert. It reads
// `media_sync_devices` (one grouped SELECT) for the apps devices report; it
// does not import the Media Sync module, which owns those writes.
//
// EXTENSION (#504): the APK release controllers/service join this module —
// append them to `controllers` / `providers` (and whatever storage module
// they need to `imports`); `AndroidAppService` is exported so the release
// service can call `ensureTrusted` when a release becomes current. The
// Doctor checks (#507) also land here.
// =============================================================================

@Module({
  controllers: [AndroidAppController, AssetLinksController],
  providers: [AndroidAppService],
  exports: [AndroidAppService],
})
export class AndroidAppModule {}

// =============================================================================
// Ports the host core needs from slices MemoriaHub has not adopted yet
// =============================================================================
//
// PlatformHostCoreModule is written against the settings slice:
// `MaintenanceModeService` reads and patches the `maintenance` namespace
// through the platform `SystemSettingsService`. MemoriaHub adopts that slice in
// RETRO-B3, and mounting it early would add `/api/system-settings` on top of the
// app's own. So this global module supplies exactly what the host core injects
// (the Doctor registries it also needs come from `DoctorModule.forRoot`, mounted
// by RETRO-B1b in `../doctor/doctor.config.ts`):
//
//   SystemSettingsService (platform class token)
//       -> `HostSystemSettingsShim`, three methods over the app's own
//          `SystemSettingsService` (which owns the `system_settings` `global`
//          row and its `maintenance.*` / `databaseBackup.*` keys, byte for byte
//          what the platform namespace stores).
//
// Reads go through `getSettings({ readOnly: true })`: the host's Doctor checks
// (`core.deployment-mode`, `maintenance.mode`) call these, and a Doctor check
// must not seed a missing settings row.
//
// PLATFORM-ADOPTION-SHIM(#597): removed by RETRO-B3 (settings token).
// =============================================================================

import { Global, Injectable, Module } from '@nestjs/common';
import { DEFAULT_MAINTENANCE_MESSAGE } from '@marinoscar/platform-api/host';
import { SystemSettingsService as PlatformSystemSettingsService } from '@marinoscar/platform-api/settings';

import { SettingsModule } from '../settings/settings.module';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

/** The slice of the platform `SystemSettingsService` the host core calls. */
@Injectable()
export class HostSystemSettingsShim {
  constructor(private readonly settings: SystemSettingsService) {}

  /**
   * `MaintenanceModeService` reads the persisted layer here (throws when the
   * database is unreadable).
   *
   * DATA COMPATIBILITY (RETRO-B3 note): the app stores `message: ''` when none
   * was ever set, but the platform namespace requires a non-empty message, so a
   * stored `''` is read as the platform's default message here. When RETRO-B3
   * mounts the real settings slice, an existing row with `message: ''` fails
   * `MAINTENANCE_SYSTEM_SETTINGS.storedSchema`; normalise it in the B3 data step.
   */
  async getMaintenancePolicy() {
    const stored = (await this.settings.getSettings({ readOnly: true })).maintenance;
    const message = stored?.message ? stored.message : DEFAULT_MAINTENANCE_MESSAGE;
    return {
      enabled: stored?.enabled ?? false,
      message,
      allowAdmins: stored?.allowAdmins ?? true,
      startedAt: stored?.startedAt ?? null,
      startedById: stored?.startedById ?? null,
    };
  }

  /** The Doctor `core.deployment-mode` check asks whether scheduled backups are on. */
  async getDatabaseBackupPolicy() {
    return (await this.settings.getSettings({ readOnly: true })).databaseBackup;
  }

  /** `MaintenanceModeService.setMaintenance` writes a partial `maintenance` patch. */
  async patchSettings(patch: Record<string, unknown>, actorUserId: string) {
    return this.settings.patchSettings(patch as never, actorUserId);
  }
}

@Global()
@Module({
  imports: [SettingsModule],
  providers: [
    HostSystemSettingsShim,
    { provide: PlatformSystemSettingsService, useExisting: HostSystemSettingsShim },
  ],
  exports: [PlatformSystemSettingsService],
})
export class HostCorePortsModule {}

import { registerStorageDriver } from '@marinoscar/platform-api/storage';

import { localStorageDriver } from '../platform-extensions/storage/local-disk.driver';

// =============================================================================
// MemoriaHub's storage drivers (RETRO-D1, #563)
// =============================================================================
//
// The platform ships the S3 family (`s3`, `r2`, `s3compatible`). MemoriaHub adds
// `local` (objects as files on the API host), the provider it always had, under
// the SAME id: existing rows say `storage_provider = 'local'`.
//
// Registered AT IMPORT TIME: the driver registry freezes at bootstrap, and the
// `storage` settings namespace reads it when it is composed, so every entry
// point reaches this file through `settings/registry/system-settings.manifest.ts`.
// =============================================================================

let registered = false;

/** Registers MemoriaHub's drivers once per process. */
export function registerMemoriaHubStorageDrivers(): void {
  if (registered) return;
  registered = true;
  registerStorageDriver(localStorageDriver);
}

registerMemoriaHubStorageDrivers();

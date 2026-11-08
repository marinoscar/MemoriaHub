import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { StorageProviderResolver } from '../../../storage/providers/storage-provider.resolver';
import { SystemSettingsService } from '../../../settings/system-settings/system-settings.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, errorMessage, fail, pass } from '../outcome';
import {
  STORAGE_PROVIDERS_PATH,
  resolveActiveStorageProvider,
} from './active-provider.doctor-check';

// Ported from `DoctorService.checkStorageLiveTest` (key `storage.liveTest`).
//
// BEHAVIOUR CHANGE (read-only rule): the old check called
// `StorageSettingsService.testConnection`, which uploads a sentinel object,
// reads it back and deletes it. The platform's Doctor is read-only (a write to
// object storage is forbidden), so this probes with a single `exists()` on a
// key that is never written (an S3 HEAD; a filesystem stat for `local`). A
// missing key is the expected, healthy answer; bad credentials, a wrong bucket
// or an unreachable endpoint throw and become a `fail`. The write round-trip
// stays available as "Test connection" on the Storage Providers page.
// Retirement: replaced by the storage slice's own check (RETRO-D1).

/** A key that is never written; the probe only asks whether it exists. */
export const STORAGE_PROBE_KEY = '__memoriahub_doctor_probe__/read-only';

export function decideStorageProbe(provider: string, bucket: string | null): DoctorCheckOutcome {
  return pass(`Read-only probe succeeded (bucket ${bucket ?? provider}).`, { provider });
}

@Injectable()
export class StorageLiveTestDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('storage', 'live-test');
  readonly category = 'storage';
  readonly label = 'Storage connectivity';
  readonly settingsPath = STORAGE_PROVIDERS_PATH;
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;
  readonly dependsOn = [checkId('storage', 'active-provider')] as const;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly resolver: StorageProviderResolver,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const settings = await this.systemSettings.getSettings({ readOnly: true });
    const provider = resolveActiveStorageProvider(settings.storage?.activeProvider, process.env['STORAGE_PROVIDER']);

    try {
      const storage = await this.resolver.getProviderFor(provider);
      await storage.exists(STORAGE_PROBE_KEY);
      return decideStorageProbe(provider, storage.getBucket() || null);
    } catch (err) {
      return fail(
        errorMessage(err) || 'Storage connectivity test failed.',
        'Fix storage credentials/bucket in Admin Settings → Storage Providers.',
        { provider },
      );
    }
  }
}

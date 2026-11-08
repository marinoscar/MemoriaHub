import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../../../prisma/prisma.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, fail, pass } from '../outcome';
import { AppSystemSettingsService } from '../../../platform/settings/app-system-settings.service';

// Ported from `DoctorService.checkActiveStorageProvider` (key
// `storage.activeProvider`). READ-ONLY: a settings read and one `findFirst`.
// Retirement: replaced by the storage slice's own checks (RETRO-D1).

export const STORAGE_PROVIDERS_PATH = '/admin/settings/storage/providers';

/** The provider new uploads go to: the setting, else `STORAGE_PROVIDER`, else `s3`. */
export function resolveActiveStorageProvider(
  activeProvider: string | undefined | null,
  envProvider: string | undefined,
): string {
  return activeProvider ?? envProvider ?? 's3';
}

export function decideActiveStorageProvider(provider: string, hasEnabledCredential: boolean): DoctorCheckOutcome {
  if (provider === 'local' || hasEnabledCredential) {
    return pass(`Active provider: ${provider}.`, { provider });
  }
  return fail(
    `No enabled credential configured for active storage provider "${provider}".`,
    'Configure a storage provider in Admin Settings → Storage Providers.',
    { provider },
  );
}

@Injectable()
export class ActiveStorageProviderDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('storage', 'active-provider');
  readonly category = 'storage';
  readonly label = 'Active storage provider';
  readonly settingsPath = STORAGE_PROVIDERS_PATH;
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;
  readonly dependsOn = ['db.connection'] as const;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: AppSystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const settings = await this.systemSettings.readKnownValue();
    const provider = resolveActiveStorageProvider(settings.storage?.activeProvider, process.env['STORAGE_PROVIDER']);
    if (provider === 'local') return decideActiveStorageProvider(provider, false);

    const cred = await this.prisma.storageProviderCredential.findFirst({
      where: { provider, enabled: true },
    });
    return decideActiveStorageProvider(provider, !!cred);
  }
}

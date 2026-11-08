import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { DOCTOR_CHECK_TIMEOUT_MS, checkId, pass, skip, warn } from '../outcome';
import { AppSystemSettingsService } from '../../../platform/settings/app-system-settings.service';

// Ported from `DoctorService.checkFaceFlagConsistency` (key
// `face.flagConsistency`). READ-ONLY: a settings read.

export function decideFaceFlagConsistency(enabled: boolean, provider: string | null | undefined): DoctorCheckOutcome {
  if (provider && !enabled) {
    return warn(
      'Face provider configured but Face Recognition feature flag is off.',
      'Enable Face Recognition in Admin Settings → Face if desired.',
    );
  }
  if (enabled) return pass('Face Recognition flag and provider configuration are consistent.');
  return skip('Face recognition disabled.');
}

@Injectable()
export class FaceFlagConsistencyDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('face', 'flag-consistency');
  readonly category = 'face';
  readonly label = 'Face flag consistency';
  readonly settingsPath = '/admin/settings/face';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly systemSettings: AppSystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const settings = await this.systemSettings.readKnownValue();
    return decideFaceFlagConsistency(
      settings.features?.['faceRecognition'] === true,
      settings.face?.features?.detection?.provider,
    );
  }
}

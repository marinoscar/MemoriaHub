import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { DOCTOR_CHECK_TIMEOUT_MS, checkId, pass, skip } from '../outcome';
import { AppSystemSettingsService } from '../../../platform/settings/app-system-settings.service';

// Ported from `DoctorService.checkBurstConfig` (key `jobs.burstConfig`).
// READ-ONLY: a settings read.

export function decideBurstConfig(enabled: boolean): DoctorCheckOutcome {
  if (!enabled) return skip('Burst detection disabled.');
  return pass('Burst detection enabled (no provider required; depends on the enrichment worker).');
}

@Injectable()
export class BurstConfigDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('jobs', 'burst-config');
  readonly category = 'jobs';
  readonly label = 'Burst detection';
  readonly settingsPath = '/admin/settings/bursts';
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
    return decideBurstConfig(settings.features?.['burstDetection'] === true);
  }
}

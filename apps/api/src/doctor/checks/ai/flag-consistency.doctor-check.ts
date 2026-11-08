import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { DOCTOR_CHECK_TIMEOUT_MS, checkId, fail, pass, warn } from '../outcome';
import { AppSystemSettingsService } from '../../../platform/settings/app-system-settings.service';

// Ported from `DoctorService.checkAiFlagConsistency` (key `ai.flagConsistency`).
// READ-ONLY: a settings read.

export function decideAiFlagConsistency(autoTaggingEnabled: boolean, taggingConfigured: boolean): DoctorCheckOutcome {
  if (autoTaggingEnabled && !taggingConfigured) {
    return fail(
      'Auto-Tagging is enabled but no tagging provider is configured.',
      'Configure a tagging provider or disable the Auto-Tagging feature flag.',
    );
  }
  if (taggingConfigured && !autoTaggingEnabled) {
    return warn(
      'Tagging provider configured but the Auto-Tagging feature flag is off.',
      'Enable Auto-Tagging in Admin Settings → Tagging if desired.',
    );
  }
  return pass('Auto-Tagging flag and provider configuration are consistent.');
}

@Injectable()
export class AiFlagConsistencyDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('ai', 'flag-consistency');
  readonly category = 'ai';
  readonly label = 'Auto-tagging flag consistency';
  readonly settingsPath = '/admin/settings/tagging';
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
    return decideAiFlagConsistency(
      settings.features?.['autoTagging'] === true,
      !!settings.ai?.features?.tagging?.provider,
    );
  }
}

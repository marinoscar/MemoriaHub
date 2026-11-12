import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import {
  DOCTOR_CHECK_TIMEOUT_MS,
  doctorCheckId,
  fail,
  pass,
  readSystemNamespaces,
  warn,
} from '../../core/index.js';
import {
  MEMORIAHUB_DOCTOR,
  MEMORIAHUB_SETTINGS,
  type MemoriahubDoctorCheck,
  type MemoriahubDoctorOutcome as DoctorCheckOutcome,
  type MemoriahubDoctorPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';

// Ported from `DoctorService.checkAiFlagConsistency` (key `ai.flagConsistency`).
// READ-ONLY: a settings read.

/** The status ladder of the AI flag consistency check. @stability experimental */
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
/** The AI flag consistency check. @stability experimental */
export class AiFlagConsistencyDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('ai', 'flag-consistency');
  readonly category = 'ai';
  readonly label = 'Auto-tagging flag consistency';
  readonly settingsPath = '/admin/settings/tagging';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    @Inject(MEMORIAHUB_DOCTOR) private readonly doctor: MemoriahubDoctorPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
  ) {}

  /** Registers the check with the diagnostics port. */
  onModuleInit(): void {
    this.doctor.registerCheck(this);
  }

  /** Runs the check. */
  async run(): Promise<DoctorCheckOutcome> {
    const settings = await readSystemNamespaces(this.settings, ['features', 'ai']);
    return decideAiFlagConsistency(
      settings.features?.['autoTagging'] === true,
      !!settings.ai?.features?.tagging?.provider,
    );
  }
}

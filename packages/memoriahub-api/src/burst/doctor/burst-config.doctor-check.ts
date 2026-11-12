import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import {
  DOCTOR_CHECK_TIMEOUT_MS,
  doctorCheckId,
  pass,
  readSystemNamespaces,
  skip,
} from '../../core/index.js';
import {
  MEMORIAHUB_DOCTOR,
  MEMORIAHUB_SETTINGS,
  type MemoriahubDoctorCheck,
  type MemoriahubDoctorOutcome as DoctorCheckOutcome,
  type MemoriahubDoctorPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';

// Ported from `DoctorService.checkBurstConfig` (key `jobs.burstConfig`).
// READ-ONLY: a settings read.

/** The status ladder of the burst detection check. @stability experimental */
export function decideBurstConfig(enabled: boolean): DoctorCheckOutcome {
  if (!enabled) return skip('Burst detection disabled.');
  return pass('Burst detection enabled (no provider required; depends on the enrichment worker).');
}

@Injectable()
/** The burst detection check. @stability experimental */
export class BurstConfigDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('jobs', 'burst-config');
  readonly category = 'jobs';
  readonly label = 'Burst detection';
  readonly settingsPath = '/admin/settings/bursts';
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
    const settings = await readSystemNamespaces(this.settings, ['features']);
    return decideBurstConfig(settings.features?.['burstDetection'] === true);
  }
}

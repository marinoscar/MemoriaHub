import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import {
  DOCTOR_CHECK_TIMEOUT_MS,
  doctorCheckId,
  pass,
  readSystemNamespaces,
  skip,
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

// Ported from `DoctorService.checkFaceFlagConsistency` (key
// `face.flagConsistency`). READ-ONLY: a settings read.

/** The status ladder of the face flag consistency check. @stability experimental */
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
/** The face flag consistency check. @stability experimental */
export class FaceFlagConsistencyDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('face', 'flag-consistency');
  readonly category = 'face';
  readonly label = 'Face flag consistency';
  readonly settingsPath = '/admin/settings/face';
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
    const settings = await readSystemNamespaces(this.settings, ['features', 'face']);
    return decideFaceFlagConsistency(
      settings.features?.['faceRecognition'] === true,
      settings.face?.features?.detection?.provider,
    );
  }
}

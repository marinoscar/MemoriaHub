import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import {
  DOCTOR_CHECK_TIMEOUT_MS,
  doctorCheckId,
  errorMessage,
  fail,
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
import { FaceSettingsService } from '../face-settings.service.js';

// Ported from `DoctorService.checkFaceDetection` (key `face.detection`).
// Live probe of the face provider (the keyless CompreFace sidecar): a
// connectivity check against the sidecar, no write and no spend.

/** The status ladder of the face detection provider check. @stability experimental */
export function decideFaceDetection(
  faceRecognitionEnabled: boolean,
  provider: string | null | undefined,
  result: { ok: boolean; error?: string } | null,
): DoctorCheckOutcome {
  if (faceRecognitionEnabled && !provider) {
    return fail(
      'Face Recognition is enabled but no detection provider is configured.',
      'Configure a face detection provider or disable Face Recognition.',
    );
  }
  if (provider) {
    if (!result?.ok) {
      return fail(
        result?.error ?? 'Face detection provider test failed.',
        'Check the provider configuration in Admin Settings → Face.',
        { provider },
      );
    }
    return pass(`Face detection provider "${provider}" reachable.`, { provider });
  }
  return skip('Face recognition disabled.');
}

@Injectable()
/** The face detection provider check. @stability experimental */
export class FaceDetectionDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('face', 'detection');
  readonly category = 'face';
  readonly label = 'Face detection provider';
  readonly settingsPath = '/admin/settings/face';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    @Inject(MEMORIAHUB_DOCTOR) private readonly doctor: MemoriahubDoctorPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly faceSettings: FaceSettingsService,
  ) {}

  /** Registers the check with the diagnostics port. */
  onModuleInit(): void {
    this.doctor.registerCheck(this);
  }

  /** Runs the check. */
  async run(): Promise<DoctorCheckOutcome> {
    const settings = await readSystemNamespaces(this.settings, ['features', 'face']);
    const enabled = settings.features?.['faceRecognition'] === true;
    const provider = settings.face?.features?.detection?.provider;
    if (!provider) return decideFaceDetection(enabled, provider, null);
    try {
      return decideFaceDetection(enabled, provider, await this.faceSettings.testProvider({ provider }));
    } catch (err) {
      return decideFaceDetection(enabled, provider, { ok: false, error: errorMessage(err) });
    }
  }
}

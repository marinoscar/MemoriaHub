import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { FaceSettingsService } from '../../../face/face-settings.service';
import { SystemSettingsService } from '../../../settings/system-settings/system-settings.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, errorMessage, fail, pass, skip } from '../outcome';

// Ported from `DoctorService.checkFaceDetection` (key `face.detection`).
// Live probe of the face provider (the keyless CompreFace sidecar): a
// connectivity check against the sidecar, no write and no spend.

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
export class FaceDetectionDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('face', 'detection');
  readonly category = 'face';
  readonly label = 'Face detection provider';
  readonly settingsPath = '/admin/settings/face';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly systemSettings: SystemSettingsService,
    private readonly faceSettings: FaceSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const settings = await this.systemSettings.getSettings({ readOnly: true });
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

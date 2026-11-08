import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { VisualEmbeddingService } from '../../../dedup/visual-embedding.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, pass, skip, warn } from '../outcome';
import { AppSystemSettingsService } from '../../../platform/settings/app-system-settings.service';

// Ported from `DoctorService.checkDuplicateDetection` (key
// `ai.duplicateDetection`). READ-ONLY. Dedup still works hash-only when the
// CLIP model is unavailable, so a degraded runtime is a warning, never a failure.

export function decideDuplicateDetection(featureEnabled: boolean, clipAvailable: boolean): DoctorCheckOutcome {
  if (!featureEnabled) return skip('Near-duplicate detection is disabled.');
  if (clipAvailable) return pass('Two-tier operational (CLIP visual embeddings + dHash).');
  return warn(
    'Running dHash-only — CLIP visual embedding model unavailable (degraded).',
    'onnxruntime native runtime failed to load; verify the API image uses a glibc base ' +
      '(not Alpine/musl) and MODELS_DIR is writable/reachable.',
  );
}

@Injectable()
export class DuplicateDetectionDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('ai', 'duplicate-detection');
  readonly category = 'ai';
  readonly label = 'Duplicate detection (CLIP)';
  readonly settingsPath = '/admin/settings/duplicates';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly visualEmbedding: VisualEmbeddingService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const settings = await this.systemSettings.readKnownValue();
    const enabled = settings.features?.['duplicateDetection'] === true;
    // Only consult the CLIP runtime when the feature is on.
    return decideDuplicateDetection(enabled, enabled && this.visualEmbedding.isAvailable());
  }
}

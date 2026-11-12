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
import { VisualEmbeddingService } from '../visual-embedding.service.js';

// Ported from `DoctorService.checkDuplicateDetection` (key
// `ai.duplicateDetection`). READ-ONLY. Dedup still works hash-only when the
// CLIP model is unavailable, so a degraded runtime is a warning, never a failure.

/** The status ladder of the duplicate detection check. @stability experimental */
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
/** The duplicate detection check. @stability experimental */
export class DuplicateDetectionDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('ai', 'duplicate-detection');
  readonly category = 'ai';
  readonly label = 'Duplicate detection (CLIP)';
  readonly settingsPath = '/admin/settings/duplicates';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    @Inject(MEMORIAHUB_DOCTOR) private readonly doctor: MemoriahubDoctorPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly visualEmbedding: VisualEmbeddingService,
  ) {}

  /** Registers the check with the diagnostics port. */
  onModuleInit(): void {
    this.doctor.registerCheck(this);
  }

  /** Runs the check. */
  async run(): Promise<DoctorCheckOutcome> {
    const settings = await readSystemNamespaces(this.settings, ['features']);
    const enabled = settings.features?.['duplicateDetection'] === true;
    // Only consult the CLIP runtime when the feature is on.
    return decideDuplicateDetection(enabled, enabled && this.visualEmbedding.isAvailable());
  }
}

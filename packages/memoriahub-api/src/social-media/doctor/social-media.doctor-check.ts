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
import { SocialMediaOcrService } from '../social-media-ocr.service.js';

// Ported from `DoctorService.checkSocialMedia` (key `ai.socialMedia`).
// READ-ONLY: a settings read and the OCR model's availability status.

/** The facts the social media detection check decides on. @stability experimental */
export interface SocialMediaInput {
  featureEnabled: boolean;
  envDisabled: boolean;
  cfg?: { ocrMaxFrames: number; ocrTimeoutSeconds: number; minConfidence: number; ocrEnabled?: boolean } | null;
  /** Resolved lazily: only asked when the feature is on, in range and OCR is enabled. */
  ocrStatus?: { ocrAvailable: boolean; degraded: boolean } | null;
}

/** Out-of-range `socialMedia.*` tunables, as sentences. @stability experimental */
export function socialMediaRangeErrors(cfg: SocialMediaInput['cfg']): string[] {
  const rangeErrors: string[] = [];
  if (cfg) {
    if (cfg.ocrMaxFrames < 2 || cfg.ocrMaxFrames > 6) rangeErrors.push(`ocrMaxFrames=${cfg.ocrMaxFrames} (expected 2–6)`);
    if (cfg.ocrTimeoutSeconds < 10 || cfg.ocrTimeoutSeconds > 300) {
      rangeErrors.push(`ocrTimeoutSeconds=${cfg.ocrTimeoutSeconds} (expected 10–300)`);
    }
    if (cfg.minConfidence < 0.5 || cfg.minConfidence > 1.0) rangeErrors.push(`minConfidence=${cfg.minConfidence} (expected 0.5–1.0)`);
  }
  return rangeErrors;
}

/** The status ladder of the social media detection check. @stability experimental */
export function decideSocialMedia(input: SocialMediaInput): DoctorCheckOutcome {
  if (!input.featureEnabled) return skip('Social media detection disabled');

  if (input.envDisabled) {
    return warn(
      'Feature enabled in settings but SOCIAL_MEDIA_DETECTION_ENABLED=false overrides it',
      'Remove or set SOCIAL_MEDIA_DETECTION_ENABLED=true',
    );
  }

  const cfg = input.cfg;
  const rangeErrors = socialMediaRangeErrors(cfg);
  if (rangeErrors.length > 0) {
    return warn(
      `Social media detection setting(s) out of range: ${rangeErrors.join(', ')}`,
      'Correct the social media detection parameters in Admin Settings.',
    );
  }

  if (cfg?.ocrEnabled === false) return pass('Tier-1 (metadata/filename) only — OCR disabled in settings');

  if (input.ocrStatus && input.ocrStatus.ocrAvailable && !input.ocrStatus.degraded) {
    return pass('Two-tier detection operational (metadata/filename + OCR)');
  }

  return warn(
    'Running Tier-1 only — OCR model unavailable (degraded)',
    'Ensure MODELS_DIR/tesseract is writable and traineddata can be fetched or pre-placed',
  );
}

@Injectable()
/** The social media detection check. @stability experimental */
export class SocialMediaDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('ai', 'social-media');
  readonly category = 'ai';
  readonly label = 'Social media detection';
  readonly settingsPath = '/admin/settings/social-media';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    @Inject(MEMORIAHUB_DOCTOR) private readonly doctor: MemoriahubDoctorPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly socialMediaOcr: SocialMediaOcrService,
  ) {}

  /** Registers the check with the diagnostics port. */
  onModuleInit(): void {
    this.doctor.registerCheck(this);
  }

  /** Runs the check. */
  async run(): Promise<DoctorCheckOutcome> {
    const settings = await readSystemNamespaces(this.settings, ['features', 'socialMedia']);
    const base: SocialMediaInput = {
      featureEnabled: settings.features?.['socialMediaDetection'] === true,
      envDisabled: process.env['SOCIAL_MEDIA_DETECTION_ENABLED'] === 'false',
      cfg: settings.socialMedia,
    };
    // Only probe the OCR model when no earlier rung already decided.
    const needsProbe =
      base.featureEnabled &&
      !base.envDisabled &&
      socialMediaRangeErrors(base.cfg).length === 0 &&
      base.cfg?.ocrEnabled !== false;
    return decideSocialMedia(needsProbe ? { ...base, ocrStatus: await this.socialMediaOcr.getStatus() } : base);
  }
}

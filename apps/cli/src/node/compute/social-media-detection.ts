/**
 * node/compute/social-media-detection.ts — Social-media video detection (scaffold).
 *
 * TODO(parity): implement via shared enrichment-compute package. Tier 1 uses
 * ffprobe container-metadata/filename rules; Tier 2 falls back to tesseract.js
 * OCR of sampled frames. For now this proves lib availability, then throws.
 */

import {
  CapabilityUnavailableError,
  loadNativeModule,
  NATIVE_MODULES,
  type ComputeFn,
} from '../capabilities.js';

const computeSocialMediaDetection: ComputeFn = async (_inputPath, _params) => {
  // tesseract is optional (Tier-2 OCR) — Tier-1 needs only ffprobe on PATH.
  await loadNativeModule(NATIVE_MODULES['tesseract']);

  throw new CapabilityUnavailableError(
    'compute for social_media_detection not yet implemented in CLI (requires ffprobe; tesseract.js for OCR Tier-2)',
    'tesseract',
  );
};

export default computeSocialMediaDetection;

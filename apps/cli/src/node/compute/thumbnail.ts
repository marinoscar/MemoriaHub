/**
 * node/compute/thumbnail.ts — Thumbnail (re)generation compute (scaffold).
 *
 * Shared by both thumbnail_regen and thumbnail_repair job types.
 *
 * TODO(parity): implement via shared enrichment-compute package. Uses sharp for
 * photo thumbnails and ffmpeg frame extraction for video posters. For now this
 * proves lib availability, then throws.
 */

import {
  CapabilityUnavailableError,
  loadNativeModule,
  NATIVE_MODULES,
  type ComputeFn,
} from '../capabilities.js';

const computeThumbnail: ComputeFn = async (_inputPath, _params) => {
  await loadNativeModule(NATIVE_MODULES['sharp']);

  throw new CapabilityUnavailableError(
    'compute for thumbnail regeneration not yet implemented in CLI (requires sharp; ffmpeg for video posters)',
    'sharp',
  );
};

export default computeThumbnail;

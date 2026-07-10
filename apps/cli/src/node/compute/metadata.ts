/**
 * node/compute/metadata.ts — Metadata-extraction compute (scaffold).
 *
 * TODO(parity): implement via shared enrichment-compute package. Runs the
 * exif/dimensions/geocode/video-probe processors. For now this proves lib
 * availability, then throws.
 */

import {
  CapabilityUnavailableError,
  loadNativeModule,
  NATIVE_MODULES,
  type ComputeFn,
} from '../capabilities.js';

const computeMetadata: ComputeFn = async (_inputPath, _params) => {
  await loadNativeModule(NATIVE_MODULES['sharp']);

  throw new CapabilityUnavailableError(
    'compute for metadata not yet implemented in CLI (requires sharp for dimensions; exifr/ffprobe for exif/probe)',
    'sharp',
  );
};

export default computeMetadata;

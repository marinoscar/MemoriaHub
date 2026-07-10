/**
 * node/compute/face-detection.ts — Photo face-detection compute (scaffold).
 *
 * TODO(parity): implement via shared enrichment-compute package. For now this
 * loads its native libraries to prove availability, then throws
 * CapabilityUnavailableError since the model math is not yet ported to the CLI.
 */

import {
  CapabilityUnavailableError,
  loadNativeModule,
  NATIVE_MODULES,
  type ComputeFn,
} from '../capabilities.js';

const computeFaceDetection: ComputeFn = async (_inputPath, _params) => {
  // Proves the native libs are loadable (throws CapabilityUnavailableError if not).
  await loadNativeModule(NATIVE_MODULES['sharp']);
  await loadNativeModule(NATIVE_MODULES['human']);

  throw new CapabilityUnavailableError(
    'compute for face_detection not yet implemented in CLI (requires @vladmandic/human)',
    'human',
  );
};

export default computeFaceDetection;

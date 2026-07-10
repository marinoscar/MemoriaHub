/**
 * node/compute/duplicate-detection.ts — Near-duplicate compute (scaffold).
 *
 * TODO(parity): implement via shared enrichment-compute package. Full path uses
 * onnxruntime-node (CLIP ViT-B/32 512-d embedding); degraded path is dHash-only
 * via sharp. For now this proves lib availability, then throws.
 */

import {
  CapabilityUnavailableError,
  loadNativeModule,
  NATIVE_MODULES,
  type ComputeFn,
} from '../capabilities.js';

const computeDuplicateDetection: ComputeFn = async (_inputPath, _params) => {
  await loadNativeModule(NATIVE_MODULES['sharp']);
  // onnxruntime is optional (degraded dHash mode) — do not hard-require it here.

  throw new CapabilityUnavailableError(
    'compute for duplicate_detection not yet implemented in CLI (requires onnxruntime-node for CLIP; sharp for dHash)',
    'onnxruntime',
  );
};

export default computeDuplicateDetection;

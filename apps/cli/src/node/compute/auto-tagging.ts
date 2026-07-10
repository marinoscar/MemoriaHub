/**
 * node/compute/auto-tagging.ts — AI auto-tagging compute (scaffold).
 *
 * TODO(parity): implement via shared enrichment-compute package. Prepares the
 * image with sharp, then calls the configured remote vision provider; the node
 * itself runs no local model here. For now this proves lib availability, then
 * throws.
 */

import {
  CapabilityUnavailableError,
  loadNativeModule,
  NATIVE_MODULES,
  type ComputeFn,
} from '../capabilities.js';

const computeAutoTagging: ComputeFn = async (_inputPath, _params) => {
  await loadNativeModule(NATIVE_MODULES['sharp']);

  throw new CapabilityUnavailableError(
    'compute for auto_tagging not yet implemented in CLI (requires sharp for image prep + a remote vision provider)',
    'sharp',
  );
};

export default computeAutoTagging;

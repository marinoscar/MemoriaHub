/**
 * node/compute/geocode.ts — Reverse-geocoding compute (scaffold).
 *
 * TODO(parity): implement via shared enrichment-compute package. Pure DB +
 * network work (no native model lib), but the offline dataset / provider client
 * is not yet ported to the CLI. For now this throws not-implemented.
 */

import { CapabilityUnavailableError, type ComputeFn } from '../capabilities.js';

const computeGeocode: ComputeFn = async (_inputPath, _params) => {
  throw new CapabilityUnavailableError(
    'compute for geocode not yet implemented in CLI (offline dataset / provider client not yet ported)',
    'geocode',
  );
};

export default computeGeocode;

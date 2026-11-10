import { defineExecutor } from './define.js';
import { sharpVitals } from './compute/telemetry-state.js';

/** `metadata_extraction`: wraps ./compute/metadata.ts. */
export const metadataExtractionExecutor = defineExecutor({
  type: 'metadata_extraction',
  input: 'download',
  load: () => import('./compute/metadata.js'),
  vitals: sharpVitals,
});

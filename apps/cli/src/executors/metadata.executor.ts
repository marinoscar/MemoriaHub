import { defineExecutor } from './define.js';

/** `metadata_extraction`: wraps ./compute/metadata.ts. */
export const metadataExtractionExecutor = defineExecutor({
  type: 'metadata_extraction',
  input: 'download',
  load: () => import('./compute/metadata.js'),
});

import { defineExecutor } from './define.js';
import { sharpVitals } from './compute/telemetry-state.js';

/** `thumbnail_regen`: wraps ./compute/thumbnail.ts. */
export const thumbnailRegenExecutor = defineExecutor({
  type: 'thumbnail_regen',
  input: 'download',
  load: () => import('./compute/thumbnail.js'),
  vitals: sharpVitals,
});

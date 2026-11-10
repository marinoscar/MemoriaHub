import { defineExecutor } from './define.js';
import { clipVitals } from './compute/clip-state.js';
import { sharpVitals } from './compute/telemetry-state.js';

/** `duplicate_detection`: wraps ./compute/duplicate-detection.ts. */
export const duplicateDetectionExecutor = defineExecutor({
  type: 'duplicate_detection',
  input: 'download',
  load: () => import('./compute/duplicate-detection.js'),
  vitals: () => ({ ...clipVitals(), ...sharpVitals() }),
});

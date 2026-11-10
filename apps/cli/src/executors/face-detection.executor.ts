import { defineExecutor } from './define.js';
import { comprefaceVitals, sharpVitals } from './compute/telemetry-state.js';

/** `face_detection`: wraps ./compute/face-detection.ts. */
export const faceDetectionExecutor = defineExecutor({
  type: 'face_detection',
  input: 'download',
  load: () => import('./compute/face-detection.js'),
  vitals: () => ({ ...comprefaceVitals(), ...sharpVitals() }),
});

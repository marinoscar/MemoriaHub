import { defineExecutor } from './define.js';
import { comprefaceVitals, sharpVitals } from './compute/telemetry-state.js';

/** `video_face_detection`: wraps ./compute/video-face-detection.ts. */
export const videoFaceDetectionExecutor = defineExecutor({
  type: 'video_face_detection',
  input: 'download',
  load: () => import('./compute/video-face-detection.js'),
  vitals: () => ({ ...comprefaceVitals(), ...sharpVitals() }),
});

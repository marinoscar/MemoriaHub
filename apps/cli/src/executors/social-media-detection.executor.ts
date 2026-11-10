import { defineExecutor } from './define.js';
import { ocrVitals } from './compute/telemetry-state.js';

/** `social_media_detection`: wraps ./compute/social-media-detection.ts. */
export const socialMediaDetectionExecutor = defineExecutor({
  type: 'social_media_detection',
  input: 'download',
  load: () => import('./compute/social-media-detection.js'),
  vitals: ocrVitals,
});

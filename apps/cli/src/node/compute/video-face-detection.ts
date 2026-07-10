/**
 * node/compute/video-face-detection.ts — Video face-detection compute (scaffold).
 *
 * TODO(parity): implement via shared enrichment-compute package. Requires ffmpeg
 * frame sampling plus @vladmandic/human per-frame detection and cross-frame
 * embedding dedup. For now this proves lib availability, then throws.
 */

import {
  CapabilityUnavailableError,
  loadNativeModule,
  NATIVE_MODULES,
  type ComputeFn,
} from '../capabilities.js';

const computeVideoFaceDetection: ComputeFn = async (_inputPath, _params) => {
  await loadNativeModule(NATIVE_MODULES['sharp']);
  await loadNativeModule(NATIVE_MODULES['human']);

  throw new CapabilityUnavailableError(
    'compute for video_face_detection not yet implemented in CLI (requires @vladmandic/human + ffmpeg)',
    'human',
  );
};

export default computeVideoFaceDetection;

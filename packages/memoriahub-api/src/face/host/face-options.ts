// =============================================================================
// FACE_OPTIONS: the options of FaceModule.forRoot
// =============================================================================

/**
 * Injection token of the resolved {@link FaceModuleOptions}.
 *
 * @stability experimental
 */
export const FACE_OPTIONS = Symbol.for('@marinoscar/memoriahub/FACE_OPTIONS');

/**
 * What a host decides about the face slice. The thresholds, the vector backend and the candidate
 * counts are read through `FACE_CONFIG` (a host binds its configuration service); the rest is here.
 *
 * @stability experimental
 */
export interface FaceModuleOptions {
  /**
   * The execution budget of a `video_face_detection` job, in milliseconds: a multi-gigabyte download,
   * ffmpeg frame extraction and one sidecar call per frame legitimately run past ten minutes on a small
   * server. Default 20 minutes.
   */
  videoJobTimeoutMs?: number;
}

/**
 * The default `videoJobTimeoutMs`: 20 minutes.
 *
 * @stability experimental
 */
export const DEFAULT_VIDEO_JOB_TIMEOUT_MS = 1_200_000;

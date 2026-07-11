/**
 * Shared ffprobe utilities.
 *
 * The implementation lives in the shared parity package
 * @memoriahub/enrichment-compute/metadata (see docs/specs/distributed-nodes.md
 * §7) so distributed worker nodes normalize container metadata EXACTLY like
 * the server. This module re-exports it under the historical path so the
 * existing import sites (VideoProbeProcessor, the social-media detection
 * handler/backfill) and their spec mocks keep working unchanged.
 */

import { probeVideo, FfprobeDataLike } from '@memoriahub/enrichment-compute/metadata';

export {
  probeVideoFile,
  extractContainerMetadata,
} from '@memoriahub/enrichment-compute/metadata';
export type {
  ContainerMetadata,
  FfprobeDataLike,
  FfprobeStreamLike,
} from '@memoriahub/enrichment-compute/metadata';

/**
 * Run ffprobe with an upper bound on runtime — historical (path, timeoutMs)
 * signature preserved; delegates to the package's probeVideo.
 */
export function probeVideoFileWithTimeout(
  filePath: string,
  timeoutMs: number,
): Promise<FfprobeDataLike> {
  return probeVideo(filePath, { ffprobeTimeoutMs: timeoutMs });
}

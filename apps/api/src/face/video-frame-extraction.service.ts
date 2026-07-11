// =============================================================================
// VideoFrameExtractionService — THIN ADAPTER
// =============================================================================
//
// Extracts JPEG frames from a video already on disk (as a file path). The
// caller owns downloading/materializing the input file and cleaning it up
// afterward.
//
// All frame-sampling math and ffmpeg invocation now live in the shared parity
// package @memoriahub/enrichment-compute/video (see
// docs/specs/distributed-nodes.md §7) so a distributed worker node samples
// frames identically to the server — one implementation, two hosts. This
// class is a thin NestJS-injectable wrapper that forwards to the package's
// pure functions unchanged; per-frame extraction-failure warnings are routed
// through the package's computeLog seam (wired to NestJS Logger once, at
// apps/api/src/storage/processing/image-orientation.util.ts import time),
// so the observable log behavior is unchanged.
// =============================================================================

import { Injectable } from '@nestjs/common';
import {
  extractFrames as computeExtractFrames,
  extractFramesAt as computeExtractFramesAt,
  type ExtractedFrame,
  type FrameExtractionOpts,
} from '@memoriahub/enrichment-compute/video';

export type { ExtractedFrame, FrameExtractionOpts };

@Injectable()
export class VideoFrameExtractionService {
  /**
   * Extract JPEG frames at computed, evenly-spaced timestamps from the video
   * already on disk at `videoPath`. See
   * @memoriahub/enrichment-compute/video's extractFrames for the full
   * sampling-strategy docs.
   */
  async extractFrames(videoPath: string, opts: FrameExtractionOpts): Promise<ExtractedFrame[]> {
    return computeExtractFrames(videoPath, opts);
  }

  /**
   * Extract JPEG frames at an EXPLICIT list of timestamps (in milliseconds).
   * See @memoriahub/enrichment-compute/video's extractFramesAt for full docs.
   */
  async extractFramesAt(
    videoPath: string,
    timestampsMs: number[],
    fileExtension?: string,
  ): Promise<ExtractedFrame[]> {
    return computeExtractFramesAt(videoPath, timestampsMs, fileExtension);
  }
}

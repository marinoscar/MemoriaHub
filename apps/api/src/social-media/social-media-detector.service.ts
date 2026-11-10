// =============================================================================
// SocialMediaDetectorService — THIN ADAPTER
// =============================================================================
//
// All rule-catalog logic now lives in the shared parity package
// @marinoscar/memoriahub-compute/social (see docs/specs/distributed-nodes.md
// §7) so a distributed worker node classifies a video IDENTICALLY to the
// server for the same inputs — one rule catalog, two hosts.
//
// This class is a zero-logic NestJS-injectable wrapper: it forwards to the
// package's pure functions unchanged so existing callers (the handler, unit
// tests instantiating `new SocialMediaDetectorService()`) keep working
// without modification.
// =============================================================================

import { Injectable } from '@nestjs/common';
import {
  detectTier1 as computeDetectTier1,
  detectCaptionSignal as computeDetectCaptionSignal,
  detectFromOcr as computeDetectFromOcr,
  type VideoDetectionInput,
  type DetectionResult,
  type SocialPlatform,
  type DetectionMethod,
} from '@marinoscar/memoriahub-compute/social';

export type { VideoDetectionInput, DetectionResult, SocialPlatform, DetectionMethod };

@Injectable()
export class SocialMediaDetectorService {
  /** See @marinoscar/memoriahub-compute/social's detectTier1 for full docs. */
  detectTier1(
    input: VideoDetectionInput,
    minConfidence = 0.8,
  ): { result: DetectionResult | null; recommendTier2: boolean } {
    return computeDetectTier1(input, minConfidence);
  }

  /** See @marinoscar/memoriahub-compute/social's detectCaptionSignal for full docs. */
  detectCaptionSignal(input: VideoDetectionInput): DetectionResult | null {
    return computeDetectCaptionSignal(input);
  }

  /** See @marinoscar/memoriahub-compute/social's detectFromOcr for full docs. */
  detectFromOcr(
    texts: string[],
    input: VideoDetectionInput,
    minConfidence = 0.8,
  ): DetectionResult | null {
    return computeDetectFromOcr(texts, input, minConfidence);
  }
}

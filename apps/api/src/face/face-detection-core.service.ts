// =============================================================================
// FaceDetectionCore
// =============================================================================
//
// Shared logic reused by both FaceDetectionService (photo path) and
// VideoFaceDetectionService (video path).
//
// Responsibilities:
//   - resolveProviderAndCreds()   — load active detection config + credentials
//   - detectWithThrottleMapping() — wrap provider.detect + Rekognition throttle mapping
//   - normalizeFace()             — bbox normalization + L2 embedding normalization
//   - persistAndMatchFaces()      — create Face rows + run person-matching loop
//   - markStatus() / markFailed() — MediaFaceStatus upsert helpers
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { MediaFaceStatusType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FaceSettingsService } from './face-settings.service';
import { FaceProviderRegistry } from './providers/face-provider.registry';
import {
  DetectedFace,
  FaceProvider,
  FaceProviderCredentials,
} from './providers/face-provider.interface';
import { FaceMatchingService } from './face-matching.service';
import { RateLimitError } from '../enrichment/rate-limit.error';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedProvider {
  provider: FaceProvider;
  creds: FaceProviderCredentials;
  providerKey: string;
  modelVersion: string;
}

export interface NormalizedFace extends DetectedFace {
  /** Embedding is always set (possibly empty array) and L2-normalized. */
  embedding: number[];
}

/**
 * Optional video-specific fields written onto the Face row.
 * For photo detections, leave all fields undefined.
 */
export interface VideoFaceFields {
  /** Timestamp of the representative frame (milliseconds from start). */
  videoTimestampMs?: number;
  /** All frame timestamps where this identity was observed (sorted). */
  videoTimestamps?: number[];
  /** Storage key for the JPEG thumbnail of the representative frame. */
  frameThumbnailKey?: string;
}

export interface PersistFaceInput {
  mediaItemId: string;
  circleId: string;
  providerKey: string;
  modelVersion: string;
  faces: Array<NormalizedFace & VideoFaceFields>;
  /** True for video faces (passes through video fields); false for photos. */
  isVideo: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class FaceDetectionCore {
  private readonly logger = new Logger(FaceDetectionCore.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly faceSettingsService: FaceSettingsService,
    private readonly registry: FaceProviderRegistry,
    private readonly matchingService: FaceMatchingService,
  ) {}

  // ---------------------------------------------------------------------------
  // resolveProviderAndCreds
  // ---------------------------------------------------------------------------

  /**
   * Load the active detection provider + credentials from system settings.
   * Throws (with an error message) when no provider is configured.
   */
  async resolveProviderAndCreds(): Promise<ResolvedProvider> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: 'global' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const faceConfig = (row?.value as any)?.face?.features?.detection as
      | { provider?: string; model?: string }
      | undefined;

    const providerKey = faceConfig?.provider;
    const modelVersion = faceConfig?.model ?? 'unknown';

    if (!providerKey) {
      throw new Error('Face detection provider not configured in system settings');
    }

    const creds = await this.faceSettingsService.resolveCredentials(providerKey);
    const provider = this.registry.get(providerKey);

    return { provider, creds, providerKey, modelVersion };
  }

  // ---------------------------------------------------------------------------
  // detectWithThrottleMapping
  // ---------------------------------------------------------------------------

  /**
   * Call provider.detect() and map Rekognition throttle errors to RateLimitError
   * so the enrichment worker routes them through the rate-limit deferral path.
   * Keyless providers (human, compreface) have no remote rate limit.
   */
  async detectWithThrottleMapping(
    provider: FaceProvider,
    creds: FaceProviderCredentials,
    buffer: Buffer,
    providerKey: string,
  ): Promise<DetectedFace[]> {
    try {
      return await provider.detect(creds, buffer);
    } catch (detectErr) {
      if (providerKey === 'rekognition') {
        const e = detectErr as Record<string, unknown> | null;
        const name = typeof e?.['name'] === 'string' ? e['name'] : undefined;
        const awsThrottleNames = new Set([
          'ThrottlingException',
          'ProvisionedThroughputExceededException',
          'TooManyRequestsException',
          'RequestLimitExceeded',
          'SlowDown',
        ]);
        if (name && awsThrottleNames.has(name)) {
          throw new RateLimitError(
            typeof e?.['message'] === 'string'
              ? e['message']
              : `Rekognition throttled: ${name}`,
            undefined,
            providerKey,
          );
        }
      }
      throw detectErr;
    }
  }

  // ---------------------------------------------------------------------------
  // normalizeFace
  // ---------------------------------------------------------------------------

  /**
   * Normalize a single detected face:
   *   1. Convert absolute pixel bbox coords to normalized 0–1 fractions
   *      (if any coord > 1.0 and dimensions are known).
   *   2. L2-normalize the embedding vector.
   *
   * Returns a new object — does not mutate the input.
   */
  normalizeFace(
    face: DetectedFace,
    uprightWidth: number,
    uprightHeight: number,
    logContext: string,
  ): NormalizedFace {
    const bb = face.boundingBox;
    let normalizedBb = bb;

    if (bb.x > 1.0 || bb.y > 1.0 || bb.w > 1.0 || bb.h > 1.0) {
      if (!uprightWidth || !uprightHeight) {
        this.logger.warn(
          `${logContext}: no dimensions available; storing raw bounding box`,
        );
      } else {
        normalizedBb = {
          x: bb.x / uprightWidth,
          y: bb.y / uprightHeight,
          w: bb.w / uprightWidth,
          h: bb.h / uprightHeight,
        };
      }
    }

    let embedding: number[] = [];
    if (face.embedding && face.embedding.length > 0) {
      embedding = l2Normalize(face.embedding);
    }

    return { ...face, boundingBox: normalizedBb, embedding };
  }

  // ---------------------------------------------------------------------------
  // persistAndMatchFaces
  // ---------------------------------------------------------------------------

  /**
   * Create Face rows for all detected faces, then run the person-matching loop.
   *
   * Video-specific fields (videoTimestampMs, videoTimestamps, frameThumbnailKey)
   * are passed through when isVideo=true and present on the face object.
   *
   * Returns the number of Face rows created.
   *
   * NOTE: Callers must delete existing non-manual Face rows (idempotency) BEFORE
   * calling this method — this service does not perform that deletion itself
   * because the photo and video paths may have different deletion strategies.
   */
  async persistAndMatchFaces(input: PersistFaceInput): Promise<number> {
    const { mediaItemId, circleId, providerKey, modelVersion, faces, isVideo } =
      input;

    if (faces.length === 0) return 0;

    const provider = this.registry.get(providerKey);

    const createdFaces: Array<{
      id: string;
      embedding: number[];
      externalFaceId: string | null;
    }> = [];

    for (const face of faces) {
      const videoFields =
        isVideo
          ? {
              videoTimestampMs: face.videoTimestampMs ?? null,
              videoTimestamps: face.videoTimestamps ?? [],
              frameThumbnailKey: face.frameThumbnailKey ?? null,
            }
          : {};

      const created = await this.prisma.face.create({
        data: {
          mediaItemId,
          circleId,
          boundingBox: face.boundingBox,
          confidence: face.confidence ?? null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          landmarks: (face.landmarks ?? null) as any,
          embedding: face.embedding ?? [],
          externalFaceId: face.externalFaceId ?? null,
          providerKey,
          modelVersion,
          manuallyAssigned: false,
          ...videoFields,
        },
        select: { id: true, embedding: true, externalFaceId: true },
      });
      createdFaces.push(created);
    }

    // Person-matching loop
    for (const face of createdFaces) {
      try {
        let matchResult: { personId: string } | null = null;

        if (face.externalFaceId && provider.capabilities.delegatedRecognize) {
          matchResult = await this.matchingService.matchFaceByExternalId(
            circleId,
            face.externalFaceId,
          );
        } else if (face.embedding.length > 0) {
          matchResult = await this.matchingService.matchFaceToPerson(
            circleId,
            face.embedding,
          );
        }

        if (matchResult) {
          await this.prisma.face.update({
            where: { id: face.id },
            data: { personId: matchResult.personId },
          });
          this.logger.debug(
            `Face ${face.id} matched to person ${matchResult.personId}`,
          );
        }
      } catch (err) {
        // Non-fatal: matching failure should not abort the detection job
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Face matching failed for face ${face.id}: ${msg}`);
      }
    }

    return createdFaces.length;
  }

  // ---------------------------------------------------------------------------
  // markStatus
  // ---------------------------------------------------------------------------

  /** Upsert MediaFaceStatus to a terminal state (processed / no_faces). */
  async markStatus(
    mediaItemId: string,
    status: Extract<MediaFaceStatusType, 'processed' | 'no_faces'>,
    faceCount: number,
    providerKey: string,
    modelVersion: string,
  ): Promise<void> {
    await this.prisma.mediaFaceStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        status,
        faceCount,
        providerKey,
        modelVersion,
        processedAt: new Date(),
      },
      update: {
        status,
        faceCount,
        providerKey,
        modelVersion,
        processedAt: new Date(),
        lastError: null,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // markProcessing
  // ---------------------------------------------------------------------------

  /** Upsert MediaFaceStatus → processing (called at the start of a job). */
  async markProcessing(mediaItemId: string): Promise<void> {
    await this.prisma.mediaFaceStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        status: MediaFaceStatusType.processing,
        faceCount: 0,
      },
      update: {
        status: MediaFaceStatusType.processing,
        lastError: null,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // markFailed
  // ---------------------------------------------------------------------------

  /** Upsert MediaFaceStatus → failed with an error message. */
  async markFailed(
    mediaItemId: string,
    providerKey: string | null,
    modelVersion: string,
    error: string,
  ): Promise<void> {
    await this.prisma.mediaFaceStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        status: MediaFaceStatusType.failed,
        faceCount: 0,
        lastError: error,
        ...(providerKey ? { providerKey, modelVersion } : {}),
      },
      update: {
        status: MediaFaceStatusType.failed,
        lastError: error,
        ...(providerKey ? { providerKey, modelVersion } : {}),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

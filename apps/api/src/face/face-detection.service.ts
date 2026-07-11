import { Injectable, Logger } from '@nestjs/common';
import { EnrichmentJob, MediaFaceStatusType } from '@prisma/client';
import { Readable } from 'stream';
import type { FaceDetectionResult } from '@memoriahub/enrichment-compute/dto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { FaceDetectionCore, ResolvedProvider } from './face-detection-core.service';
import type { DetectedFace } from './providers/face-provider.interface';

@Injectable()
export class FaceDetectionService {
  private readonly logger = new Logger(FaceDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly core: FaceDetectionCore,
  ) {}

  // ---------------------------------------------------------------------------
  // processMediaItem — orchestrates the in-process path: resolve provider,
  // download, computeFaces (compute half), persistFaces (persist half). A
  // distributed worker node runs the equivalent of computeFaces locally and
  // submits the resulting DTO to FaceDetectionHandler.persistNodeResult, which
  // calls persistFaces directly — the same persist code path either way.
  // ---------------------------------------------------------------------------

  async processMediaItem(job: EnrichmentJob): Promise<void> {
    // Guard: face_detection jobs must always have a mediaItemId (global/null jobs are not valid here)
    if (!job.mediaItemId) {
      throw new Error('face_detection job missing mediaItemId');
    }

    // 1. Set MediaFaceStatus → processing
    await this.core.markProcessing(job.mediaItemId);

    // 2. Load face detection config + resolve credentials
    let resolved: ResolvedProvider;
    try {
      resolved = await this.core.resolveProviderAndCreds();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`FaceJob ${job.id}: ${errMsg}`);
      await this.core.markFailed(job.mediaItemId, null, 'unknown', errMsg);
      throw err;
    }

    await this.enrichmentJobService.recordModel(job.id, resolved.providerKey, resolved.modelVersion);

    try {
      // 3. Load MediaItem with storageObject
      const mediaItem = await this.prisma.mediaItem.findUnique({
        where: { id: job.mediaItemId },
        select: {
          id: true,
          width: true,
          height: true,
          storageObject: {
            select: { storageKey: true, storageProvider: true, bucket: true },
          },
        },
      });

      if (!mediaItem || !mediaItem.storageObject) {
        const errMsg = `MediaItem ${job.mediaItemId} or its StorageObject not found`;
        this.logger.error(`FaceJob ${job.id}: ${errMsg}`);
        await this.core.markFailed(job.mediaItemId, resolved.providerKey, resolved.modelVersion, errMsg);
        throw new Error(errMsg);
      }

      // 4. Download image → buffer (resolved via the object's own provider+bucket)
      const objectProvider = await this.resolver.getProviderFor(
        mediaItem.storageObject.storageProvider,
        mediaItem.storageObject.bucket,
      );
      const stream = await objectProvider.download(mediaItem.storageObject.storageKey);
      const buffer = await streamToBuffer(stream);

      // 5-6. Compute half: prepare (EXIF orientation + downscale) + detect
      const result = await this.computeFaces(
        buffer,
        resolved,
        { width: mediaItem.width ?? 0, height: mediaItem.height ?? 0 },
        `FaceJob ${job.id}`,
      );

      // 7-10. Persist half: delete-then-recreate Face rows, match, mark status
      await this.persistFaces(job, result);

      this.logger.log(
        `FaceJob ${job.id}: detected ${result.faces.length} face(s) in MediaItem ${job.mediaItemId} using ${result.providerKey}/${result.modelVersion}`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.core.markFailed(job.mediaItemId, resolved.providerKey, resolved.modelVersion, errMsg);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // computeFaces — COMPUTE half of the split.
  //
  // Prepares the image (EXIF orientation + downscale to FACE_MAX_IMAGE_DIM,
  // falling back to the raw buffer + the MediaItem's stored dimensions when
  // preprocessing fails) and runs detection through the resolved provider.
  // Bounding boxes stay in PIXEL space in the returned DTO — normalization to
  // the faces-table 0-1 convention is entirely the PERSIST half's job
  // (persistFaces), mirroring where FaceDetectionCore.normalizeFace ran in the
  // pre-split code.
  //
  // This is the SERVER-side compute half, used for the in-process path. A
  // distributed worker node runs the equivalent compute locally (always via
  // the keyless Human provider — see warnOnProviderMismatch below) and
  // submits the same DTO shape directly, bypassing this method.
  // ---------------------------------------------------------------------------

  async computeFaces(
    buffer: Buffer,
    resolved: ResolvedProvider,
    fallbackDims: { width: number; height: number },
    logContext: string,
  ): Promise<FaceDetectionResult> {
    const MAX = parseInt(process.env.FACE_MAX_IMAGE_DIM ?? '2000', 10);

    let uprightBuffer = buffer;
    let uprightWidth = fallbackDims.width;
    let uprightHeight = fallbackDims.height;
    const prepared = await prepareImageForProcessing(buffer, { maxDim: MAX });
    if (prepared.width > 0 && prepared.height > 0) {
      uprightBuffer = prepared.buffer;
      uprightWidth = prepared.width;
      uprightHeight = prepared.height;
    } else {
      this.logger.warn(
        `${logContext}: image preprocessing failed; falling back to raw buffer/MediaItem dims`,
      );
    }

    const detectedFaces = await this.core.detectWithThrottleMapping(
      resolved.provider,
      resolved.creds,
      uprightBuffer,
      resolved.providerKey,
    );

    return {
      modelVersion: resolved.modelVersion,
      providerKey: resolved.providerKey,
      imageWidth: uprightWidth,
      imageHeight: uprightHeight,
      faces: detectedFaces.map((face) => ({
        // PIXEL coords relative to imageWidth/imageHeight above — see the DTO
        // docstring in @memoriahub/enrichment-compute/dto.
        boundingBox: {
          x: face.boundingBox.x,
          y: face.boundingBox.y,
          width: face.boundingBox.w,
          height: face.boundingBox.h,
        },
        confidence: face.confidence,
        landmarks: face.landmarks,
        embedding: face.embedding && face.embedding.length > 0 ? face.embedding : [],
        externalFaceId: face.externalFaceId,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // persistFaces — PERSIST half of the split.
  //
  // Shared by the in-process path (processMediaItem, above) and the node
  // result-ingestion path (FaceDetectionHandler.persistNodeResult). Does NOT
  // recompute or download anything — it only writes Face rows, runs person
  // matching, and upserts MediaFaceStatus from an already-computed DTO.
  // ---------------------------------------------------------------------------

  async persistFaces(job: EnrichmentJob, result: FaceDetectionResult): Promise<void> {
    if (!job.mediaItemId) {
      throw new Error('face_detection job missing mediaItemId');
    }
    if (!job.circleId) {
      throw new Error('face_detection job missing circleId');
    }

    await this.warnOnProviderMismatch(job.id, result.providerKey);

    // Delete existing non-manual Face rows (idempotency) — unconditional, even
    // when zero faces are in the result, so a rerun that now finds nothing
    // still clears stale detections.
    await this.prisma.face.deleteMany({
      where: { mediaItemId: job.mediaItemId, manuallyAssigned: false },
    });

    if (result.faces.length > 0) {
      const logCtx = `FaceJob ${job.id} MediaItem ${job.mediaItemId}`;
      const normalized = result.faces.map((face) => {
        const asDetected: DetectedFace = {
          boundingBox: {
            x: face.boundingBox.x,
            y: face.boundingBox.y,
            w: face.boundingBox.width,
            h: face.boundingBox.height,
          },
          confidence: face.confidence,
          landmarks: face.landmarks,
          embedding: face.embedding,
          externalFaceId: face.externalFaceId,
        };
        return this.core.normalizeFace(asDetected, result.imageWidth, result.imageHeight, logCtx);
      });

      await this.core.persistAndMatchFaces({
        mediaItemId: job.mediaItemId,
        circleId: job.circleId,
        providerKey: result.providerKey,
        modelVersion: result.modelVersion,
        faces: normalized,
        isVideo: false,
      });
    }

    const finalStatus =
      result.faces.length > 0 ? MediaFaceStatusType.processed : MediaFaceStatusType.no_faces;

    await this.core.markStatus(
      job.mediaItemId,
      finalStatus,
      result.faces.length,
      result.providerKey,
      result.modelVersion,
    );
  }

  // ---------------------------------------------------------------------------
  // warnOnProviderMismatch
  //
  // A distributed worker node ALWAYS computes with the keyless Human provider
  // (1024-d embeddings); the server's ACTIVE provider (system settings
  // face.features.detection) might be compreface (128-d) or a delegated
  // provider like rekognition. persistFaces trusts the DTO's own
  // providerKey/modelVersion to tag the created Face rows — but person-
  // matching cosine similarity only works within ONE embedding space, so if a
  // node-computed 1024-d result lands in a circle whose existing faces are
  // 128-d compreface vectors, the new faces will silently cluster separately
  // rather than matching existing People (same class of silent-degradation
  // risk the distributed-nodes spec §7 accepts for embedding parity in
  // general). This warning is operator visibility only — it never blocks
  // persistence, and a resolution failure here is swallowed.
  // ---------------------------------------------------------------------------

  private async warnOnProviderMismatch(jobId: string, resultProviderKey: string): Promise<void> {
    try {
      const active = await this.core.resolveProviderAndCreds();
      if (active.providerKey !== resultProviderKey) {
        this.logger.warn(
          `FaceJob ${jobId}: result providerKey="${resultProviderKey}" differs from the currently-active ` +
            `server provider "${active.providerKey}" — person-matching cosine similarity operates in a ` +
            `different embedding space than the circle's existing faces (silent match degradation risk)`,
        );
      }
    } catch {
      // Best-effort only — a provider-resolution failure here must never block persistence.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

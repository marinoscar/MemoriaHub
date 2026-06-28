import { Injectable, Logger } from '@nestjs/common';
import { EnrichmentJob, MediaFaceStatusType } from '@prisma/client';
import { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { FaceDetectionCore } from './face-detection-core.service';

@Injectable()
export class FaceDetectionService {
  private readonly logger = new Logger(FaceDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly core: FaceDetectionCore,
  ) {}

  async processMediaItem(job: EnrichmentJob): Promise<void> {
    // Guard: face_detection jobs must always have a mediaItemId (global/null jobs are not valid here)
    if (!job.mediaItemId) {
      throw new Error('face_detection job missing mediaItemId');
    }

    // 1. Set MediaFaceStatus → processing
    await this.core.markProcessing(job.mediaItemId);

    // 2. Load face detection config + resolve credentials
    let providerKey: string;
    let modelVersion: string;

    let resolved: Awaited<ReturnType<FaceDetectionCore['resolveProviderAndCreds']>>;
    try {
      resolved = await this.core.resolveProviderAndCreds();
      providerKey = resolved.providerKey;
      modelVersion = resolved.modelVersion;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`FaceJob ${job.id}: ${errMsg}`);
      await this.core.markFailed(job.mediaItemId, null, 'unknown', errMsg);
      throw err;
    }

    await this.enrichmentJobService.recordModel(job.id, providerKey, modelVersion);

    try {
      // 3. Load MediaItem with storageObject
      const mediaItem = await this.prisma.mediaItem.findUnique({
        where: { id: job.mediaItemId },
        select: {
          id: true,
          circleId: true,
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
        await this.core.markFailed(job.mediaItemId, providerKey, modelVersion, errMsg);
        throw new Error(errMsg);
      }

      // 4. Download image → buffer (resolved via the object's own provider+bucket)
      const objectProvider = await this.resolver.getProviderFor(
        mediaItem.storageObject.storageProvider,
        mediaItem.storageObject.bucket,
      );
      const stream = await objectProvider.download(mediaItem.storageObject.storageKey);
      const buffer = await streamToBuffer(stream);

      // 5. Apply EXIF orientation + downscale before detection
      const MAX = parseInt(process.env.FACE_MAX_IMAGE_DIM ?? '2000', 10);
      let uprightBuffer = buffer;
      let uprightWidth = mediaItem.width ?? 0;
      let uprightHeight = mediaItem.height ?? 0;
      const prepared = await prepareImageForProcessing(buffer, { maxDim: MAX });
      if (prepared.width > 0 && prepared.height > 0) {
        uprightBuffer = prepared.buffer;
        uprightWidth = prepared.width;
        uprightHeight = prepared.height;
      } else {
        this.logger.warn(
          `FaceJob ${job.id}: image preprocessing failed; falling back to raw buffer for MediaItem ${job.mediaItemId}`,
        );
      }

      // 6. Detect faces
      const detectedFaces = await this.core.detectWithThrottleMapping(
        resolved.provider,
        resolved.creds,
        uprightBuffer,
        providerKey,
      );

      // 7. Delete existing non-manual Face rows (idempotency)
      await this.prisma.face.deleteMany({
        where: {
          mediaItemId: job.mediaItemId,
          manuallyAssigned: false,
        },
      });

      if (detectedFaces.length > 0) {
        // 8. Normalize bounding boxes and L2-normalize embeddings
        const logCtx = `FaceJob ${job.id} MediaItem ${mediaItem.id}`;
        const normalized = detectedFaces.map((face) =>
          this.core.normalizeFace(face, uprightWidth, uprightHeight, logCtx),
        );

        // 9. Persist Face rows + run person-matching loop
        await this.core.persistAndMatchFaces({
          mediaItemId: job.mediaItemId,
          circleId: mediaItem.circleId,
          providerKey,
          modelVersion,
          faces: normalized,
          isVideo: false,
        });
      }

      // 10. Upsert MediaFaceStatus
      const finalStatus =
        detectedFaces.length > 0
          ? MediaFaceStatusType.processed
          : MediaFaceStatusType.no_faces;

      await this.core.markStatus(
        job.mediaItemId,
        finalStatus,
        detectedFaces.length,
        providerKey,
        modelVersion,
      );

      this.logger.log(
        `FaceJob ${job.id}: detected ${detectedFaces.length} face(s) in MediaItem ${job.mediaItemId} using ${providerKey}/${modelVersion}`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.core.markFailed(job.mediaItemId, providerKey, modelVersion, errMsg);
      throw err;
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

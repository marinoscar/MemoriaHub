import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnrichmentJob, MediaFaceStatusType } from '@prisma/client';
import { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { FaceSettingsService } from './face-settings.service';
import { FaceProviderRegistry } from './providers/face-provider.registry';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { DetectedFace } from './providers/face-provider.interface';
import { FaceMatchingService } from './face-matching.service';

@Injectable()
export class FaceDetectionService {
  private readonly logger = new Logger(FaceDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly faceSettingsService: FaceSettingsService,
    private readonly registry: FaceProviderRegistry,
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
    private readonly matchingService: FaceMatchingService,
  ) {}

  async processMediaItem(job: EnrichmentJob): Promise<void> {
    // 1. Set MediaFaceStatus → processing
    await this.prisma.mediaFaceStatus.upsert({
      where: { mediaItemId: job.mediaItemId },
      create: {
        mediaItemId: job.mediaItemId,
        status: MediaFaceStatusType.processing,
        faceCount: 0,
      },
      update: {
        status: MediaFaceStatusType.processing,
        lastError: null,
      },
    });

    // 2. Load face detection config from raw DB
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
      const errMsg = 'Face detection provider not configured in system settings';
      this.logger.error(`FaceJob ${job.id}: ${errMsg}`);
      await this.markFailed(job.mediaItemId, null, modelVersion, errMsg);
      throw new Error(errMsg);
    }

    // 3. Resolve credentials
    const creds = await this.faceSettingsService.resolveCredentials(providerKey);
    const provider = this.registry.get(providerKey);

    try {
      // 4. Load MediaItem with storageObject
      const mediaItem = await this.prisma.mediaItem.findUnique({
        where: { id: job.mediaItemId },
        select: {
          id: true,
          circleId: true,
          width: true,
          height: true,
          storageObject: {
            select: { storageKey: true },
          },
        },
      });

      if (!mediaItem || !mediaItem.storageObject) {
        const errMsg = `MediaItem ${job.mediaItemId} or its StorageObject not found`;
        this.logger.error(`FaceJob ${job.id}: ${errMsg}`);
        await this.markFailed(job.mediaItemId, providerKey, modelVersion, errMsg);
        throw new Error(errMsg);
      }

      // 5. Download image → buffer
      const stream = await this.storageProvider.download(mediaItem.storageObject.storageKey);
      const buffer = await streamToBuffer(stream);

      // 6. Detect faces
      const detectedFaces: DetectedFace[] = await provider.detect(creds, buffer);

      // 7. Delete existing non-manual Face rows (idempotency)
      await this.prisma.face.deleteMany({
        where: {
          mediaItemId: job.mediaItemId,
          manuallyAssigned: false,
        },
      });

      if (detectedFaces.length > 0) {
        // 8. Normalize bounding boxes and L2-normalize embeddings
        const normalized = detectedFaces.map((face) => {
          const bb = face.boundingBox;
          let normalizedBb = bb;

          // Detect absolute pixel coords: if any coordinate > 1.0
          if (bb.x > 1.0 || bb.y > 1.0 || bb.w > 1.0 || bb.h > 1.0) {
            const w = mediaItem.width;
            const h = mediaItem.height;

            if (!w || !h) {
              this.logger.warn(
                `MediaItem ${mediaItem.id} has no dimensions; storing raw bounding box for FaceJob ${job.id}`,
              );
              normalizedBb = bb; // store raw, best effort
            } else {
              normalizedBb = {
                x: bb.x / w,
                y: bb.y / h,
                w: bb.w / w,
                h: bb.h / h,
              };
            }
          }
          // else: already normalized (0–1 fractions), store as-is

          // 9. L2-normalize embedding if present
          let embedding: number[] = [];
          if (face.embedding && face.embedding.length > 0) {
            embedding = l2Normalize(face.embedding);
          }

          return { ...face, boundingBox: normalizedBb, embedding };
        });

        // 10. Create Face rows individually (loop instead of createMany) so we
        //     have the returned IDs for matching in step 11.
        //     Typical face count per photo is 1–10, so the loop is acceptable.
        const createdFaces: Array<{
          id: string;
          embedding: number[];
          externalFaceId: string | null;
        }> = [];

        for (const face of normalized) {
          const created = await this.prisma.face.create({
            data: {
              mediaItemId: job.mediaItemId,
              circleId: mediaItem.circleId,
              boundingBox: face.boundingBox,
              confidence: face.confidence ?? null,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              landmarks: (face.landmarks ?? null) as any,
              embedding: face.embedding ?? [],
              externalFaceId: face.externalFaceId ?? null,
              providerKey,
              modelVersion,
              manuallyAssigned: false,
            },
            select: { id: true, embedding: true, externalFaceId: true },
          });
          createdFaces.push(created);
        }

        // 11. Match each new face to a Person (or leave unknown)
        for (const face of createdFaces) {
          try {
            let matchResult: { personId: string } | null = null;

            if (face.externalFaceId && provider.capabilities.delegatedRecognize) {
              // Delegated path: look up by external face ID
              matchResult = await this.matchingService.matchFaceByExternalId(
                mediaItem.circleId,
                face.externalFaceId,
              );
            } else if (face.embedding.length > 0) {
              // In-app cosine path
              matchResult = await this.matchingService.matchFaceToPerson(
                mediaItem.circleId,
                face.embedding,
              );
            }

            if (matchResult) {
              await this.prisma.face.update({
                where: { id: face.id },
                data: { personId: matchResult.personId },
              });
              this.logger.debug(
                `FaceJob ${job.id}: face ${face.id} matched to person ${matchResult.personId}`,
              );
            }
          } catch (err) {
            // Non-fatal: matching failure should not abort the detection job
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `FaceJob ${job.id}: face matching failed for face ${face.id}: ${msg}`,
            );
          }
        }
      }

      // 12. Upsert MediaFaceStatus
      const finalStatus =
        detectedFaces.length > 0
          ? MediaFaceStatusType.processed
          : MediaFaceStatusType.no_faces;

      await this.prisma.mediaFaceStatus.upsert({
        where: { mediaItemId: job.mediaItemId },
        create: {
          mediaItemId: job.mediaItemId,
          status: finalStatus,
          faceCount: detectedFaces.length,
          providerKey,
          modelVersion,
          processedAt: new Date(),
        },
        update: {
          status: finalStatus,
          faceCount: detectedFaces.length,
          providerKey,
          modelVersion,
          processedAt: new Date(),
          lastError: null,
        },
      });

      this.logger.log(
        `FaceJob ${job.id}: detected ${detectedFaces.length} face(s) in MediaItem ${job.mediaItemId}`,
      );
    } catch (err) {
      // On any unexpected error after the initial status→processing upsert,
      // mark the item as failed so the status row is never left as "processing".
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.markFailed(job.mediaItemId, providerKey, modelVersion, errMsg);
      throw err;
    }
  }

  private async markFailed(
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

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

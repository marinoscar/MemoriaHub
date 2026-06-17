import { Inject, Injectable, Logger } from '@nestjs/common';
import { FaceJob, MediaFaceStatusType } from '@prisma/client';
import { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { FaceSettingsService } from './face-settings.service';
import { FaceProviderRegistry } from './providers/face-provider.registry';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../storage/providers/storage-provider.interface';
import { DetectedFace } from './providers/face-provider.interface';

@Injectable()
export class FaceDetectionService {
  private readonly logger = new Logger(FaceDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly faceSettingsService: FaceSettingsService,
    private readonly registry: FaceProviderRegistry,
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
  ) {}

  async processMediaItem(job: FaceJob): Promise<void> {
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

      // 10. createMany Face rows
      await this.prisma.face.createMany({
        data: normalized.map((face) => ({
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
        })),
      });
    }

    // 11. Upsert MediaFaceStatus
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

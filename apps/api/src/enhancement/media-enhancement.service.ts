import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CircleRole,
  MediaType,
  MediaEnhancementStatus,
  MediaEnhancementDecision,
  MediaTagSource,
  JobReason,
  MediaFaceStatusType,
  Prisma,
} from '@prisma/client';
import { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';
import { MediaMetadataSyncService } from '../media/sync/media-metadata-sync.service';
import { MediaEnrichmentService } from '../media/enrichment/media-enrichment.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { EnhanceParams } from './dto/enhance-params.dto';
import {
  buildEnhancePrompt,
  closestSupportedSize,
  sizeToDims,
} from './enhance-prompt.builder';
import { randomUUID } from 'crypto';
import { extname } from 'path';

const SYSTEM_TAG = 'AI Enhanced';

interface CompareSection {
  url: string | null;
  width: number | null;
  height: number | null;
  size: string | null;
}

@Injectable()
export class MediaEnhancementService {
  private readonly logger = new Logger(MediaEnhancementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembership: CircleMembershipService,
    private readonly resolver: StorageProviderResolver,
    private readonly recoveryService: StorageProcessingRecoveryService,
    private readonly metadataSync: MediaMetadataSyncService,
    private readonly mediaEnrichment: MediaEnrichmentService,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /api/admin/ai/enhance/status
  // ---------------------------------------------------------------------------

  async getAdminStatus() {
    const settings = await this.systemSettings.getSettings();
    const featureEnabled =
      settings.features?.['pictureEnhancement'] === true &&
      process.env['PICTURE_ENHANCEMENT_ENABLED'] !== 'false';
    const enhanceCfg = settings.ai?.features?.enhance ?? null;
    const provider = enhanceCfg?.provider ?? null;
    const model = enhanceCfg?.model ?? null;

    let credentialConfigured = false;
    if (provider) {
      const cred = await this.prisma.aiProviderCredential.findUnique({
        where: { provider },
      });
      credentialConfigured = !!cred && cred.enabled;
    }

    return {
      featureEnabled,
      provider,
      model,
      credentialConfigured,
      ready: featureEnabled && credentialConfigured && !!model,
    };
  }

  // ---------------------------------------------------------------------------
  // POST /api/media/:id/enhance
  // ---------------------------------------------------------------------------

  async startEnhance(mediaItemId: string, params: EnhanceParams, user: RequestUser) {
    const settings = await this.systemSettings.getSettings();

    // Feature gate: system setting + env kill-switch.
    const featureOn = settings.features?.['pictureEnhancement'] === true;
    const envKilled = process.env['PICTURE_ENHANCEMENT_ENABLED'] === 'false';
    if (!featureOn || envKilled) {
      throw new BadRequestException('Picture enhancement is disabled');
    }

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        type: true,
        deletedAt: true,
        width: true,
        height: true,
        storageObject: { select: { id: true, mimeType: true } },
      },
    });

    if (!mediaItem || mediaItem.deletedAt || !mediaItem.storageObject) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    await this.circleMembership.assertCircleAccess(
      user.id,
      mediaItem.circleId,
      user.permissions,
      'collaborator' as CircleRole,
    );

    // Photo-only guard (mirrors media-orientation-edit.service).
    if (
      mediaItem.type !== MediaType.photo ||
      !mediaItem.storageObject.mimeType.startsWith('image/')
    ) {
      throw new BadRequestException('Picture enhancement is only supported for photos');
    }

    // Enhance model must be configured.
    const enhanceCfg = settings.ai?.features?.enhance;
    if (!enhanceCfg?.provider || !enhanceCfg?.model) {
      throw new BadRequestException(
        'No enhancement model configured (ai.features.enhance is unset)',
      );
    }
    const provider = enhanceCfg.provider;
    const model = params.model ?? enhanceCfg.model;

    // Megapixel guard.
    const maxMp = settings.pictureEnhancement?.maxInputMegapixels ?? 50;
    if (mediaItem.width && mediaItem.height) {
      const mp = (mediaItem.width * mediaItem.height) / 1_000_000;
      if (mp > maxMp) {
        throw new BadRequestException(
          `Image is ${mp.toFixed(1)} MP, which exceeds the ${maxMp} MP limit`,
        );
      }
    }

    // Supersede any existing live enhancement for this item (one live at a time).
    await this.supersedeLive(mediaItemId);

    // Compile the prompt deterministically at creation time (params + strength).
    const effectiveStrength =
      params.strength ?? settings.pictureEnhancement?.defaultStrength ?? 'balanced';
    const prompt = buildEnhancePrompt(params, effectiveStrength);

    const row = await this.prisma.mediaEnhancement.create({
      data: {
        mediaItemId: mediaItem.id,
        circleId: mediaItem.circleId,
        status: MediaEnhancementStatus.pending,
        params: (params ?? {}) as Prisma.InputJsonValue,
        provider,
        model,
        prompt,
        originalWidth: mediaItem.width,
        originalHeight: mediaItem.height,
        createdById: user.id,
      },
    });

    const job = await this.enrichmentJobService.enqueue({
      type: 'picture_enhancement',
      mediaItemId: mediaItem.id,
      circleId: mediaItem.circleId,
      reason: JobReason.rerun,
      priority: 0,
      providerKey: provider,
      modelVersion: model,
      payload: { enhancementId: row.id },
    });

    this.logger.log(
      `Enqueued picture_enhancement job ${job.id} for enhancement ${row.id} (MediaItem ${mediaItem.id})`,
    );

    return { data: { enhancementId: row.id, jobId: job.id, status: 'pending' } };
  }

  /**
   * Discard the staging bytes of, and mark discarded, any live (pending /
   * processing / ready) enhancement for the item — one live at a time.
   */
  private async supersedeLive(mediaItemId: string): Promise<void> {
    const live = await this.prisma.mediaEnhancement.findMany({
      where: {
        mediaItemId,
        status: {
          in: [
            MediaEnhancementStatus.pending,
            MediaEnhancementStatus.processing,
            MediaEnhancementStatus.ready,
          ],
        },
      },
    });

    for (const row of live) {
      await this.deleteStaging(row);
      await this.prisma.mediaEnhancement.update({
        where: { id: row.id },
        data: { status: MediaEnhancementStatus.discarded, stagingStorageKey: null },
      });
      this.logger.log(`Superseded live enhancement ${row.id} for MediaItem ${mediaItemId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/media/:id/enhance/:enhancementId  and  GET /api/media/:id/enhance
  // ---------------------------------------------------------------------------

  async getEnhancement(
    mediaItemId: string,
    enhancementId: string,
    user: RequestUser,
  ) {
    const row = await this.loadRowForItem(mediaItemId, enhancementId, user, 'viewer');
    return { data: await this.buildComparePayload(mediaItemId, row) };
  }

  async getLatestEnhancement(mediaItemId: string, user: RequestUser) {
    const mediaItem = await this.assertItemAccess(mediaItemId, user, 'viewer');
    const row = await this.prisma.mediaEnhancement.findFirst({
      where: { mediaItemId: mediaItem.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      return { data: null };
    }
    return { data: await this.buildComparePayload(mediaItemId, row) };
  }

  private async buildComparePayload(
    mediaItemId: string,
    row: Awaited<ReturnType<PrismaService['mediaEnhancement']['findUniqueOrThrow']>>,
  ) {
    const base: Record<string, unknown> = {
      id: row.id,
      status: row.status,
      model: row.model,
      params: row.params ?? {},
    };

    if (row.status === MediaEnhancementStatus.failed) {
      base['lastError'] = row.lastError ?? null;
    }

    // Signed URLs + dimension deltas only meaningful once ready.
    if (row.status === MediaEnhancementStatus.ready && row.stagingStorageKey) {
      const original = await this.signOriginal(mediaItemId);
      const enhanced = await this.signStaging(row);
      const downscaled =
        !!original.width &&
        !!original.height &&
        !!row.enhancedWidth &&
        !!row.enhancedHeight &&
        row.enhancedWidth * row.enhancedHeight < original.width * original.height;
      return {
        ...base,
        original,
        enhanced,
        downscaled,
      };
    }

    return base;
  }

  private async signOriginal(mediaItemId: string): Promise<CompareSection> {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        width: true,
        height: true,
        storageObject: {
          select: { storageKey: true, storageProvider: true, bucket: true, size: true },
        },
      },
    });
    if (!item?.storageObject) {
      return { url: null, width: item?.width ?? null, height: item?.height ?? null, size: null };
    }
    const provider = await this.resolver.getProviderFor(
      item.storageObject.storageProvider,
      item.storageObject.bucket,
    );
    const url = await provider.getSignedDownloadUrl(item.storageObject.storageKey);
    return {
      url,
      width: item.width,
      height: item.height,
      size: item.storageObject.size != null ? item.storageObject.size.toString() : null,
    };
  }

  private async signStaging(
    row: Awaited<ReturnType<PrismaService['mediaEnhancement']['findUniqueOrThrow']>>,
  ): Promise<CompareSection> {
    if (!row.stagingStorageKey || !row.stagingProvider) {
      return {
        url: null,
        width: row.enhancedWidth,
        height: row.enhancedHeight,
        size: row.enhancedSize != null ? row.enhancedSize.toString() : null,
      };
    }
    const provider = await this.resolver.getProviderFor(row.stagingProvider, row.stagingBucket);
    const url = await provider.getSignedDownloadUrl(row.stagingStorageKey);
    return {
      url,
      width: row.enhancedWidth,
      height: row.enhancedHeight,
      size: row.enhancedSize != null ? row.enhancedSize.toString() : null,
    };
  }

  // ---------------------------------------------------------------------------
  // POST /api/media/:id/enhance/:enhancementId/apply
  // ---------------------------------------------------------------------------

  async applyEnhancement(
    mediaItemId: string,
    enhancementId: string,
    decision: 'keep_both' | 'replace',
    user: RequestUser,
  ) {
    const row = await this.loadRowForItem(mediaItemId, enhancementId, user, 'collaborator');

    if (row.status !== MediaEnhancementStatus.ready || !row.stagingStorageKey) {
      throw new BadRequestException('Enhancement is not ready to apply');
    }

    if (decision === 'keep_both') {
      return this.applyKeepBoth(mediaItemId, row, user);
    }
    return this.applyReplace(mediaItemId, row, user);
  }

  private async applyKeepBoth(
    mediaItemId: string,
    row: Awaited<ReturnType<PrismaService['mediaEnhancement']['findUniqueOrThrow']>>,
    user: RequestUser,
  ) {
    const source = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        type: true,
        source: true,
        capturedAt: true,
        capturedAtOffset: true,
        cameraMake: true,
        cameraModel: true,
        originalFilename: true,
        takenLat: true,
        takenLng: true,
        takenAltitude: true,
        geoCountry: true,
        geoCountryCode: true,
        geoAdmin1: true,
        geoAdmin2: true,
        geoLocality: true,
        geoPlaceName: true,
        geoSource: true,
        geocodedAt: true,
        coordSource: true,
      },
    });
    if (!source) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    // Download the staged enhanced bytes.
    const stagingProvider = await this.resolver.getProviderFor(
      row.stagingProvider!,
      row.stagingBucket,
    );
    const bytes = await streamToBuffer(await stagingProvider.download(row.stagingStorageKey!));

    // Promote the bytes to a fresh permanent object on the ACTIVE provider so
    // the new item owns its own storage (independent of the purge-swept staging
    // key).
    const { id: activeProviderId, provider: activeProvider } =
      await this.resolver.getActiveProvider();
    const enhancedFilename = this.suffixFilename(source.originalFilename);
    const storageKey = `uploads/${Date.now()}/${randomUUID()}.jpg`;
    await activeProvider.upload(storageKey, Readable.from(bytes), {
      mimeType: 'image/jpeg',
      contentLength: bytes.length,
    });

    const newObject = await this.prisma.storageObject.create({
      data: {
        name: enhancedFilename,
        size: BigInt(bytes.length),
        mimeType: 'image/jpeg',
        storageKey,
        storageProvider: activeProviderId,
        bucket: activeProvider.getBucket(),
        status: 'pending',
        uploadedById: user.id,
      },
    });

    const breadcrumb = {
      _aiEnhanced: {
        model: row.model,
        at: new Date().toISOString(),
        enhancementId: row.id,
        fromId: source.id,
      },
      _enhancedFrom: source.id,
    };

    const newItem = await this.prisma.mediaItem.create({
      data: {
        storageObjectId: newObject.id,
        addedById: user.id,
        circleId: source.circleId,
        type: MediaType.photo,
        source: source.source,
        originalFilename: enhancedFilename,
        capturedAt: source.capturedAt,
        capturedAtOffset: source.capturedAtOffset,
        cameraMake: source.cameraMake,
        cameraModel: source.cameraModel,
        orientation: 1,
        width: row.enhancedWidth,
        height: row.enhancedHeight,
        takenLat: source.takenLat,
        takenLng: source.takenLng,
        takenAltitude: source.takenAltitude,
        geoCountry: source.geoCountry,
        geoCountryCode: source.geoCountryCode,
        geoAdmin1: source.geoAdmin1,
        geoAdmin2: source.geoAdmin2,
        geoLocality: source.geoLocality,
        geoPlaceName: source.geoPlaceName,
        geoSource: source.geoSource,
        geocodedAt: source.geocodedAt,
        coordSource: source.coordSource,
        contentHash: null,
        metadata: breadcrumb as Prisma.InputJsonValue,
      },
    });

    // Re-derive width/height/size/contentHash + thumbnails from the enhanced
    // bytes via the standard reprocess pipeline.
    await this.recoveryService.reprocessObjectNow(newObject);
    try {
      await this.metadataSync.syncFromStorageObject(newObject.id);
    } catch (err) {
      this.logger.warn(
        `keep_both: metadata sync failed for new object ${newObject.id} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // In-app AI-Enhanced marker (system tag).
    await this.applySystemTag(newItem.id, source.circleId, user.id);

    // Standard upload-time enrichment (tagging/faces/etc), idempotent.
    await this.mediaEnrichment.enqueueUploadEnrichment({
      id: newItem.id,
      type: MediaType.photo,
      circleId: source.circleId,
      deletedAt: null,
    });

    // Delete the staging bytes now that they are promoted, and finalize the row.
    await this.deleteStaging(row);
    await this.prisma.mediaEnhancement.update({
      where: { id: row.id },
      data: {
        status: MediaEnhancementStatus.applied,
        decision: MediaEnhancementDecision.keep_both,
        resultMediaItemId: newItem.id,
        stagingStorageKey: null,
      },
    });

    await this.writeAudit(user.id, mediaItemId, {
      enhancementId: row.id,
      decision: 'keep_both',
      resultMediaItemId: newItem.id,
      model: row.model,
    });

    this.logger.log(
      `Enhancement ${row.id} applied (keep_both) — new MediaItem ${newItem.id} from ${mediaItemId}`,
    );

    return { data: { id: newItem.id, status: 'applied', decision: 'keep_both' } };
  }

  private async applyReplace(
    mediaItemId: string,
    row: Awaited<ReturnType<PrismaService['mediaEnhancement']['findUniqueOrThrow']>>,
    user: RequestUser,
  ) {
    const settings = await this.systemSettings.getSettings();
    const enhCfg = settings.pictureEnhancement;

    if (enhCfg && enhCfg.allowReplace === false) {
      throw new BadRequestException('Replace is disabled by administrator policy');
    }

    const source = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        width: true,
        height: true,
        metadata: true,
        storageObject: true,
      },
    });
    if (!source || !source.storageObject) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }

    // Downscale-block policy.
    const downscaled =
      !!source.width &&
      !!source.height &&
      !!row.enhancedWidth &&
      !!row.enhancedHeight &&
      row.enhancedWidth * row.enhancedHeight < source.width * source.height;
    if (enhCfg?.blockReplaceOnDownscale === true && downscaled) {
      throw new BadRequestException(
        'Replace is blocked because the enhanced image is lower resolution than the original',
      );
    }

    const storageObject = source.storageObject;

    // Download staged bytes and overwrite the ORIGINAL key on its own provider.
    const stagingProvider = await this.resolver.getProviderFor(
      row.stagingProvider!,
      row.stagingBucket,
    );
    const bytes = await streamToBuffer(await stagingProvider.download(row.stagingStorageKey!));

    const objectProvider = await this.resolver.getProviderFor(
      storageObject.storageProvider,
      storageObject.bucket,
    );
    await objectProvider.upload(storageObject.storageKey, Readable.from(bytes), {
      mimeType: 'image/jpeg',
      contentLength: bytes.length,
    });

    // Merge the AI-enhanced breadcrumb into existing metadata.
    const existingMeta =
      (source.metadata as Record<string, unknown> | null) ?? {};
    const mergedMeta: Record<string, unknown> = {
      ...existingMeta,
      _aiEnhanced: {
        model: row.model,
        at: new Date().toISOString(),
        enhancementId: row.id,
      },
    };

    // Null the contentHash so reprocess recomputes it from the new bytes.
    await this.prisma.$transaction([
      this.prisma.storageObject.update({
        where: { id: storageObject.id },
        data: { size: BigInt(bytes.length), mimeType: 'image/jpeg' },
      }),
      this.prisma.mediaItem.update({
        where: { id: source.id },
        data: {
          contentHash: null,
          orientation: 1,
          width: row.enhancedWidth,
          height: row.enhancedHeight,
          metadata: mergedMeta as Prisma.InputJsonValue,
        },
      }),
    ]);

    // Regenerate thumbnails + re-derive dims/hash from the new bytes.
    let status = 'failed';
    const refreshed = await this.prisma.storageObject.findUnique({
      where: { id: storageObject.id },
    });
    let width = row.enhancedWidth ?? source.width ?? 0;
    let height = row.enhancedHeight ?? source.height ?? 0;
    if (refreshed) {
      await this.recoveryService.reprocessObjectNow(refreshed);
      const after = await this.prisma.storageObject.findUnique({
        where: { id: storageObject.id },
        select: { status: true },
      });
      status = after?.status ?? 'unknown';
      const item = await this.prisma.mediaItem.findUnique({
        where: { id: source.id },
        select: { width: true, height: true },
      });
      width = item?.width ?? width;
      height = item?.height ?? height;
    }

    // In-app AI-Enhanced marker.
    await this.applySystemTag(source.id, source.circleId, user.id);

    // Rotation/regeneration invalidates face boxes — best-effort re-enqueue.
    await this.reenqueueFaceDetection(source.id, source.circleId);

    // Delete staging bytes, finalize row.
    await this.deleteStaging(row);
    await this.prisma.mediaEnhancement.update({
      where: { id: row.id },
      data: {
        status: MediaEnhancementStatus.applied,
        decision: MediaEnhancementDecision.replace,
        stagingStorageKey: null,
      },
    });

    await this.writeAudit(user.id, mediaItemId, {
      enhancementId: row.id,
      decision: 'replace',
      model: row.model,
      status,
    });

    this.logger.log(
      `Enhancement ${row.id} applied (replace) on MediaItem ${mediaItemId} — status=${status} ${width}x${height}`,
    );

    return { data: { status, width, height } };
  }

  // ---------------------------------------------------------------------------
  // POST /api/media/:id/enhance/:enhancementId/discard
  // ---------------------------------------------------------------------------

  async discardEnhancement(
    mediaItemId: string,
    enhancementId: string,
    user: RequestUser,
  ): Promise<void> {
    const row = await this.loadRowForItem(mediaItemId, enhancementId, user, 'collaborator');
    await this.deleteStaging(row);
    await this.prisma.mediaEnhancement.update({
      where: { id: row.id },
      data: { status: MediaEnhancementStatus.discarded, stagingStorageKey: null },
    });
    this.logger.log(`Enhancement ${row.id} discarded for MediaItem ${mediaItemId}`);
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private async assertItemAccess(
    mediaItemId: string,
    user: RequestUser,
    required: 'viewer' | 'collaborator',
  ) {
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { id: true, circleId: true, deletedAt: true },
    });
    if (!mediaItem || mediaItem.deletedAt) {
      throw new NotFoundException(`MediaItem ${mediaItemId} not found`);
    }
    await this.circleMembership.assertCircleAccess(
      user.id,
      mediaItem.circleId,
      user.permissions,
      required as CircleRole,
    );
    return mediaItem;
  }

  private async loadRowForItem(
    mediaItemId: string,
    enhancementId: string,
    user: RequestUser,
    required: 'viewer' | 'collaborator',
  ) {
    await this.assertItemAccess(mediaItemId, user, required);
    const row = await this.prisma.mediaEnhancement.findUnique({
      where: { id: enhancementId },
    });
    if (!row || row.mediaItemId !== mediaItemId) {
      throw new NotFoundException(`Enhancement ${enhancementId} not found`);
    }
    return row;
  }

  private async deleteStaging(
    row: Awaited<ReturnType<PrismaService['mediaEnhancement']['findUniqueOrThrow']>>,
  ): Promise<void> {
    if (!row.stagingStorageKey || !row.stagingProvider) return;
    try {
      const provider = await this.resolver.getProviderFor(
        row.stagingProvider,
        row.stagingBucket,
      );
      await provider.delete(row.stagingStorageKey);
    } catch (err) {
      this.logger.warn(
        `deleteStaging: failed to delete ${row.stagingStorageKey} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async applySystemTag(
    mediaItemId: string,
    circleId: string,
    addedById: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const tag = await tx.tag.upsert({
        where: { circleId_name: { circleId, name: SYSTEM_TAG } },
        create: { addedById, circleId, name: SYSTEM_TAG },
        update: {},
      });
      await tx.mediaTag.upsert({
        where: { tagId_mediaItemId: { tagId: tag.id, mediaItemId } },
        create: { tagId: tag.id, mediaItemId, source: MediaTagSource.system },
        update: {},
      });
      await tx.mediaTag.updateMany({
        where: { tagId: tag.id, mediaItemId, source: MediaTagSource.ai },
        data: { source: MediaTagSource.system },
      });
    });
  }

  private async reenqueueFaceDetection(
    mediaItemId: string,
    circleId: string,
  ): Promise<void> {
    try {
      const settings = await this.systemSettings.getSettings();
      const faceOn = settings.features?.['faceRecognition'] === true;
      const faceKilled = (process.env['FACE_AUTO_DETECT'] ?? 'true') === 'false';
      if (!faceOn || faceKilled) return;

      await this.enrichmentJobService.enqueue({
        type: 'face_detection',
        mediaItemId,
        circleId,
        reason: JobReason.rerun,
        priority: 0,
      });
      await this.prisma.mediaFaceStatus.upsert({
        where: { mediaItemId },
        create: { mediaItemId, status: MediaFaceStatusType.pending, faceCount: 0 },
        update: { status: MediaFaceStatusType.pending },
      });
    } catch (err) {
      this.logger.warn(
        `reenqueueFaceDetection failed for MediaItem ${mediaItemId} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async writeAudit(
    actorUserId: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId,
          action: 'media_enhancement:applied',
          targetType: 'media_item',
          targetId,
          meta: meta as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(
        `writeAudit failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private suffixFilename(name: string): string {
    const ext = extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    return `${base} (enhanced)${ext || '.jpg'}`;
  }

  // Re-exported for the handler so size/prompt resolution stays in one place.
  static resolveSize = closestSupportedSize;
  static sizeToDims = sizeToDims;
}

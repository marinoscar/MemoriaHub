import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  OBJECT_PROCESSED_EVENT,
  ObjectProcessedEvent,
} from '../../storage/processing/events/object-processed.event';

/**
 * MediaMetadataSyncService
 *
 * Listens for OBJECT_PROCESSED_EVENT and syncs extracted processor metadata
 * from StorageObject.metadata._processing into the typed columns of the
 * linked MediaItem.
 *
 * Circular dependency avoidance (Constraint B):
 *   The storage processing module emits OBJECT_PROCESSED_EVENT after all
 *   processors have run.  This service lives inside MediaModule and only
 *   depends on PrismaService (already available via the global PrismaModule).
 *   It does NOT import or depend on StorageModule/ObjectProcessingModule,
 *   breaking any potential cycle.
 *
 * If no MediaItem is linked to the StorageObject, the handler no-ops
 * gracefully.
 *
 * Mapping:
 *   _processing['content-hash'].sha256          → contentHash
 *   _processing['exif'].capturedAt              → capturedAt
 *   _processing['exif'].capturedAtOffset        → capturedAtOffset
 *   _processing['exif'].latitude                → takenLat
 *   _processing['exif'].longitude               → takenLng
 *   _processing['exif'].altitude                → takenAltitude
 *   _processing['exif'].cameraMake              → cameraMake
 *   _processing['exif'].cameraModel             → cameraModel
 *   _processing['exif'].orientation             → orientation
 *   _processing['dimensions'].width             → width  (images)
 *   _processing['dimensions'].height            → height (images)
 *   _processing['video-probe'].width            → width  (videos)
 *   _processing['video-probe'].height           → height (videos)
 *   _processing['video-probe'].durationMs       → durationMs
 *   _processing['video-probe'].capturedAt       → capturedAt (videos, only when exif absent)
 *   _processing['geocode'].country              → geoCountry
 *   _processing['geocode'].countryCode          → geoCountryCode
 *   _processing['geocode'].admin1               → geoAdmin1
 *   _processing['geocode'].admin2               → geoAdmin2
 *   _processing['geocode'].locality             → geoLocality
 *   _processing['geocode'].placeName            → geoPlaceName
 *   _processing['geocode'].source               → geoSource
 *   _processing['geocode'].geocodedAt           → geocodedAt
 *
 * Only columns whose source value is present (not undefined) are updated.
 * Existing data is never nulled out.
 */
@Injectable()
export class MediaMetadataSyncService {
  private readonly logger = new Logger(MediaMetadataSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Core sync logic: reads processor metadata from the StorageObject and copies
   * present-only values into the typed columns of the linked MediaItem.
   *
   * Safe to call at any time:
   *   - If the StorageObject does not exist → no-op (warns).
   *   - If no MediaItem is linked yet → no-op (debug).
   *   - If `_processing` metadata is absent → no-op (debug).
   *   - If called twice for the same object (event path + create-time path) the
   *     second call writes the same values, making the operation idempotent.
   *
   * This method is public so that MediaService.createMedia can call it
   * immediately after inserting the MediaItem row, ensuring enrichment lands
   * even when processing finishes before the MediaItem is created (race fix).
   */
  async syncFromStorageObject(storageObjectId: string): Promise<void> {
    // Load the storage object and its metadata
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: storageObjectId },
      select: { id: true, metadata: true },
    });

    if (!storageObject) {
      this.logger.warn(`StorageObject ${storageObjectId} not found; skipping sync`);
      return;
    }

    // Find the linked MediaItem
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { storageObjectId },
      select: { id: true, contentHash: true },
    });

    if (!mediaItem) {
      // Normal case when called from the event path before createMedia runs,
      // or an edge case where no MediaItem was ever created.
      this.logger.debug(
        `No MediaItem linked to StorageObject ${storageObjectId}; skipping sync`,
      );
      return;
    }

    const meta = storageObject.metadata as Record<string, unknown> | null;
    const processing = meta?.['_processing'] as Record<string, Record<string, unknown>> | undefined;

    if (!processing) {
      this.logger.debug(`No _processing metadata for StorageObject ${storageObjectId}`);
      return;
    }

    const update: Prisma.MediaItemUpdateInput = {};

    // --- content-hash ---
    // Only set the hash when the MediaItem's contentHash is currently NULL.
    // If the client already supplied a hash at registration time (non-null), keep it.
    // If both are present but differ, log a warning (integrity mismatch) and retain
    // the existing client-supplied value rather than overwriting it.
    const hashMeta = processing['content-hash'];
    if (typeof hashMeta?.['sha256'] === 'string') {
      const serverHash = (hashMeta['sha256'] as string).toLowerCase();
      // contentHash may be null (never set) or undefined (not selected — treated the same way)
      const currentHash = mediaItem.contentHash ?? null;
      if (currentHash === null) {
        update.contentHash = serverHash;
      } else if (currentHash.toLowerCase() !== serverHash) {
        this.logger.warn(
          `Content hash integrity mismatch for MediaItem ${mediaItem.id}: ` +
            `client-supplied=${currentHash}, server-computed=${serverHash}. ` +
            `Keeping client-supplied value.`,
        );
        // Do NOT set update.contentHash — leave the existing value in place
      }
      // else: hashes match, no update needed
    }

    // --- exif ---
    const exifMeta = processing['exif'];
    if (exifMeta) {
      if (typeof exifMeta['capturedAt'] === 'string') {
        update.capturedAt = new Date(exifMeta['capturedAt']);
      }
      if (typeof exifMeta['capturedAtOffset'] === 'number') {
        update.capturedAtOffset = exifMeta['capturedAtOffset'];
      }
      if (typeof exifMeta['latitude'] === 'number') {
        update.takenLat = exifMeta['latitude'];
      }
      if (typeof exifMeta['longitude'] === 'number') {
        update.takenLng = exifMeta['longitude'];
      }
      if (typeof exifMeta['altitude'] === 'number') {
        update.takenAltitude = exifMeta['altitude'];
      }
      if (typeof exifMeta['cameraMake'] === 'string') {
        update.cameraMake = exifMeta['cameraMake'];
      }
      if (typeof exifMeta['cameraModel'] === 'string') {
        update.cameraModel = exifMeta['cameraModel'];
      }
      if (typeof exifMeta['orientation'] === 'number') {
        update.orientation = exifMeta['orientation'];
      }
      if (typeof exifMeta['burstUuid'] === 'string') {
        update.burstUuid = exifMeta['burstUuid'];
      }
    }

    // --- visual-hash ---
    const visualHashMeta = processing['visual-hash'];
    if (visualHashMeta) {
      if (typeof visualHashMeta['perceptualHash'] === 'string') {
        // The processor emits the unsigned decimal string directly; store as-is.
        // Validate it parses as a valid BigInt before accepting (rejects garbage).
        try {
          BigInt(visualHashMeta['perceptualHash']); // validation only
          update.perceptualHash = visualHashMeta['perceptualHash'];
        } catch {
          // ignore invalid values
        }
      }
      if (typeof visualHashMeta['sharpnessScore'] === 'number') {
        update.sharpnessScore = visualHashMeta['sharpnessScore'];
      }
    }

    // --- dimensions (images) ---
    const dimMeta = processing['dimensions'];
    if (dimMeta) {
      if (typeof dimMeta['width'] === 'number') {
        update.width = dimMeta['width'];
      }
      if (typeof dimMeta['height'] === 'number') {
        update.height = dimMeta['height'];
      }
    }

    // --- video-probe (videos; overrides dimensions if both somehow present) ---
    const videoProbeMeta = processing['video-probe'];
    if (videoProbeMeta) {
      if (typeof videoProbeMeta['width'] === 'number') {
        update.width = videoProbeMeta['width'];
      }
      if (typeof videoProbeMeta['height'] === 'number') {
        update.height = videoProbeMeta['height'];
      }
      if (typeof videoProbeMeta['durationMs'] === 'number') {
        update.durationMs = videoProbeMeta['durationMs'];
      }
      // capturedAt from video creation_time — only when exif didn't already set it
      // (exif block is processed above; if exif.capturedAt was present it is
      // already set in update.capturedAt and we do NOT override it here)
      if (update.capturedAt === undefined && typeof videoProbeMeta['capturedAt'] === 'string') {
        update.capturedAt = new Date(videoProbeMeta['capturedAt']);
      }
    }

    // --- geocode ---
    const geocodeMeta = processing['geocode'];
    if (geocodeMeta) {
      if (typeof geocodeMeta['country'] === 'string') {
        update.geoCountry = geocodeMeta['country'];
      }
      if (typeof geocodeMeta['countryCode'] === 'string') {
        update.geoCountryCode = geocodeMeta['countryCode'];
      }
      if (typeof geocodeMeta['admin1'] === 'string') {
        update.geoAdmin1 = geocodeMeta['admin1'];
      }
      if (typeof geocodeMeta['admin2'] === 'string') {
        update.geoAdmin2 = geocodeMeta['admin2'];
      }
      if (typeof geocodeMeta['locality'] === 'string') {
        update.geoLocality = geocodeMeta['locality'];
      }
      if (typeof geocodeMeta['placeName'] === 'string') {
        update.geoPlaceName = geocodeMeta['placeName'];
      }
      if (typeof geocodeMeta['source'] === 'string') {
        update.geoSource = geocodeMeta['source'];
      }
      if (typeof geocodeMeta['geocodedAt'] === 'string') {
        update.geocodedAt = new Date(geocodeMeta['geocodedAt']);
      }
    }

    // --- thumbnail ---
    // When the ThumbnailProcessor ran successfully, merge the stable object
    // reference into MediaItem.metadata so the read path can sign a fresh URL
    // at query time without a second DB lookup.
    //
    // We do a read-modify-write on the JSONB column to preserve any existing
    // metadata keys (e.g. keys set by the caller at MediaItem creation time).
    const thumbMeta = processing['thumbnail'];
    if (
      typeof thumbMeta?.['thumbnailObjectId'] === 'string' &&
      typeof thumbMeta?.['thumbnailStorageKey'] === 'string'
    ) {
      // Load current MediaItem.metadata to merge into it
      const currentItem = await this.prisma.mediaItem.findUnique({
        where: { id: mediaItem.id },
        select: { metadata: true },
      });

      const existingMeta =
        (currentItem?.metadata as Record<string, unknown> | null) ?? {};

      update.metadata = {
        ...existingMeta,
        thumbnailObjectId: thumbMeta['thumbnailObjectId'],
        thumbnailStorageKey: thumbMeta['thumbnailStorageKey'],
      } as Prisma.InputJsonValue;
    }

    // Only run the DB update if there is anything to update
    if (Object.keys(update).length === 0) {
      this.logger.debug(`No typed fields to sync for MediaItem ${mediaItem.id}`);
      return;
    }

    // Wrap the update so that a P2002 on the content-hash unique index
    // (e.g. a client that did not supply a hash but whose computed hash
    // collides with an already-registered item) is caught and logged rather
    // than crashing the processing pipeline.  We leave the item without a
    // contentHash in that case — it is a duplicate that can be surfaced via
    // a separate dedup audit job if needed.
    try {
      await this.prisma.mediaItem.update({
        where: { id: mediaItem.id },
        data: update,
      });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.warn(
          `Content hash collision on backfill for MediaItem ${mediaItem.id} — ` +
            `the computed hash already belongs to another item. ` +
            `Retrying update without contentHash to preserve other enrichment fields.`,
        );
        // Remove contentHash from the update and retry so enrichment is not lost entirely
        const { contentHash: _dropped, ...updateWithoutHash } = update;
        if (Object.keys(updateWithoutHash).length > 0) {
          await this.prisma.mediaItem.update({
            where: { id: mediaItem.id },
            data: updateWithoutHash,
          });
        }
        return;
      }
      throw err;
    }

    this.logger.log(
      `Synced ${Object.keys(update).length} metadata field(s) into MediaItem ${mediaItem.id}`,
    );
  }

  @OnEvent(OBJECT_PROCESSED_EVENT, { async: true })
  async handleObjectProcessed(event: ObjectProcessedEvent): Promise<void> {
    const { storageObjectId } = event;

    try {
      await this.syncFromStorageObject(storageObjectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `MediaMetadataSyncService failed for StorageObject ${storageObjectId}: ${message}`,
      );
      // Do NOT rethrow — a sync failure should not crash the event loop
    }
  }
}

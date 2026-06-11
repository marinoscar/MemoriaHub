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
      select: { id: true },
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
    const hashMeta = processing['content-hash'];
    if (typeof hashMeta?.['sha256'] === 'string') {
      update.contentHash = hashMeta['sha256'];
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

    await this.prisma.mediaItem.update({
      where: { id: mediaItem.id },
      data: update,
    });

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

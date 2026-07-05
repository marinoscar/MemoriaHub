import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTimeInput } from '../../common/schemas/iso-date';

export const createMediaSchema = z.object({
  storageObjectId: z.string().uuid('storageObjectId must be a valid UUID'),
  type: z.enum(['photo', 'video']),
  source: z.enum(['web', 'cli', 'android', 'import', 'sync']),
  originalFilename: z.string().min(1).max(1024),
  capturedAt: isoDateTimeInput.optional(),
  capturedAtOffset: z.number().int().optional(),
  description: z.string().max(8192).optional(),
  favorite: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Provenance
  originalCreatedAt: isoDateTimeInput.optional(),
  sourcePath: z.string().max(2048).optional(),
  sourceDeviceId: z.string().max(256).optional(),
  sourceDeviceName: z.string().max(256).optional(),
  circleId: z.string().uuid(),
  /**
   * Client-supplied FALLBACK location (e.g. from a per-folder memoriahub.json
   * override). Applied only when the item has no EXIF GPS: the server-extracted
   * EXIF location always wins. `coordSource` is restricted to `'manual'` so a
   * client cannot spoof `'exif'`/`'inferred'` provenance.
   */
  takenLat: z.number().min(-90).max(90).optional(),
  takenLng: z.number().min(-180).max(180).optional(),
  takenAltitude: z.number().optional(),
  coordSource: z.literal('manual').optional(),
  /**
   * Client-provided SHA-256 content hash (64 lowercase hex characters).
   * When supplied, the server uses it to deduplicate: if an active MediaItem
   * with the same (circle_id, content_hash) already exists the existing item is
   * returned without creating a new one. The redundant StorageObject blob is
   * cleaned up best-effort. If omitted, dedup still occurs via the database
   * unique-index when the hash is later computed by the content-hash processor.
   */
  contentHash: z
    .string()
    .regex(
      /^[a-f0-9]{64}$/i,
      'contentHash must be a 64-char hex SHA-256',
    )
    .optional(),
});

export class CreateMediaDto extends createZodDto(createMediaSchema) {}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createMediaSchema = z.object({
  storageObjectId: z.string().uuid('storageObjectId must be a valid UUID'),
  type: z.enum(['photo', 'video']),
  source: z.enum(['web', 'cli', 'android', 'import', 'sync']),
  originalFilename: z.string().min(1).max(1024),
  capturedAt: z.coerce.date().optional(),
  capturedAtOffset: z.number().int().optional(),
  classification: z.enum(['memory', 'low_value', 'unreviewed']).optional(),
  title: z.string().max(512).optional(),
  caption: z.string().max(2048).optional(),
  description: z.string().max(8192).optional(),
  favorite: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Provenance
  originalCreatedAt: z.coerce.date().optional(),
  sourcePath: z.string().max(2048).optional(),
  sourceDeviceId: z.string().max(256).optional(),
  sourceDeviceName: z.string().max(256).optional(),
});

export class CreateMediaDto extends createZodDto(createMediaSchema) {}

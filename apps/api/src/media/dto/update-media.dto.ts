import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTimeInput } from '../../common/schemas/iso-date';

export const updateMediaSchema = z.object({
  capturedAt: isoDateTimeInput.nullable().optional(),
  capturedAtOffset: z.number().int().nullable().optional(),
  classification: z.enum(['memory', 'low_value', 'unreviewed']).optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  caption: z.string().max(2048).nullable().optional(),
  description: z.string().max(8192).nullable().optional(),
  favorite: z.boolean().optional(),
});

export class UpdateMediaDto extends createZodDto(updateMediaSchema) {}

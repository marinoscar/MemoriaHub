import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTimeInput } from '../../common/schemas/iso-date';

export const updateMediaSchema = z.object({
  capturedAt: isoDateTimeInput.nullable().optional(),
  capturedAtOffset: z.number().int().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  description: z.string().max(8192).nullable().optional(),
  favorite: z.boolean().optional(),
  // .default({}) so a bodyless request parses as {} — see issue #289 (app.module.ts).
}).default({});

export class UpdateMediaDto extends createZodDto(updateMediaSchema) {}

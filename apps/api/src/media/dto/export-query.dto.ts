import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoDateTimeInput } from '../../common/schemas/iso-date';

export const exportQuerySchema = z.object({
  /** Output format: newline-delimited JSON or RFC 4180 CSV */
  format: z.enum(['json', 'csv']).default('json'),
  /** Circle whose media items to export */
  circleId: z.string().uuid(),
  /** Filter by media type */
  type: z.enum(['photo', 'video']).optional(),
  /** Filter capturedAt >= from */
  from: isoDateTimeInput.optional(),
  /** Filter capturedAt <= to */
  to: isoDateTimeInput.optional(),
});

export class ExportQueryDto extends createZodDto(exportQuerySchema) {}

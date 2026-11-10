import { z } from 'zod';
import { isoDateTimeInput } from '../primitives/index.js';


/**
 * Wire schema `exportQuerySchema`.
 *
 * @stability experimental
 */
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

/**
 * The parsed value of {@link exportQuerySchema}.
 *
 * @stability experimental
 */
export type ExportQuery = z.infer<typeof exportQuerySchema>;

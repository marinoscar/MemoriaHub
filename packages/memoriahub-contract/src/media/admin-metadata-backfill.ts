import { z } from 'zod';
import { flexibleDate } from '../primitives/index.js';

/**
 * Wire schema `adminMetadataBackfillSchema`.
 *
 * @stability experimental
 */
export const adminMetadataBackfillSchema = z.object({
  from: flexibleDate.optional(),
  to: flexibleDate.optional(),
  force: z.boolean().optional().default(false),
  // .prefault({}) — not .default({}) — because the inner force default makes
  // `force` required in the output type, and .default() would return a bare {}
  // without running this parse (leaving force undefined). .prefault() feeds {}
  // THROUGH the schema, so a bodyless POST is identical to {}. See issue #289.
}).prefault({});

/**
 * The parsed value of {@link adminMetadataBackfillSchema}.
 *
 * @stability experimental
 */
export type AdminMetadataBackfill = z.infer<typeof adminMetadataBackfillSchema>;

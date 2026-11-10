import { z } from 'zod';

/**
 * Wire schema `adminLocationInferenceBackfillSchema`.
 *
 * @stability experimental
 */
export const adminLocationInferenceBackfillSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  force: z.boolean().optional().default(false),
  // .prefault({}) so a bodyless POST parses exactly like {} (force: false) —
  // see issue #289 (app.module.ts) and admin-metadata.controller.ts.
}).prefault({});

/**
 * The parsed value of {@link adminLocationInferenceBackfillSchema}.
 *
 * @stability experimental
 */
export type AdminLocationInferenceBackfill = z.infer<typeof adminLocationInferenceBackfillSchema>;

import { z } from 'zod';

/**
 * Wire schema `adminBurstBackfillSchema`.
 *
 * @stability experimental
 */
export const adminBurstBackfillSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  force: z.boolean().optional().default(false),
  // .prefault({}) so a bodyless POST parses exactly like {} (force: false) —
  // see issue #289 (app.module.ts) and admin-metadata.controller.ts.
}).prefault({});

/**
 * The parsed value of {@link adminBurstBackfillSchema}.
 *
 * @stability experimental
 */
export type AdminBurstBackfill = z.infer<typeof adminBurstBackfillSchema>;

import { z } from 'zod';
import { flexibleDate } from '../primitives/index.js';

/**
 * Wire schema `adminFaceBackfillSchema`.
 *
 * @stability experimental
 */
export const adminFaceBackfillSchema = z.object({
  from: flexibleDate.optional(),
  to: flexibleDate.optional(),
  force: z.boolean().optional().default(false),
  // .prefault({}) so a bodyless POST parses exactly like {} (force: false) —
  // see issue #289 (app.module.ts) and admin-metadata.controller.ts.
}).prefault({});

/**
 * The parsed value of {@link adminFaceBackfillSchema}.
 *
 * @stability experimental
 */
export type AdminFaceBackfill = z.infer<typeof adminFaceBackfillSchema>;

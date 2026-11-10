import { z } from 'zod';
import { flexibleDate } from '../primitives/index.js';

/**
 * Wire schema `backfillGeoSchema`.
 *
 * @stability experimental
 */
export const backfillGeoSchema = z.object({
  from: flexibleDate.optional(),
  to: flexibleDate.optional(),
  force: z.boolean().optional().default(false),
  // .prefault({}) so a bodyless POST parses exactly like {} (force: false) —
  // see issue #289 (app.module.ts) and admin-metadata.controller.ts.
}).prefault({});

/**
 * The parsed value of {@link backfillGeoSchema}.
 *
 * @stability experimental
 */
export type BackfillGeo = z.infer<typeof backfillGeoSchema>;

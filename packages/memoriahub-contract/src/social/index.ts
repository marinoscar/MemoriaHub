/**
 * @packageDocumentation
 * Wire schemas of social-media video detection: the admin backfill request.
 */
import { z } from 'zod';
import { flexibleDate } from '../primitives/index.js';

/**
 * Body of `POST /api/admin/social-media/backfill`.
 *
 * @stability experimental
 */
export const adminSocialMediaBackfillSchema = z.object({
  from: flexibleDate.optional(),
  to: flexibleDate.optional(),
  force: z.boolean().optional().default(false),
  // .prefault({}) so a bodyless POST parses exactly like {} (force: false), issue #289.
}).prefault({});

/**
 * The parsed value of {@link adminSocialMediaBackfillSchema}.
 *
 * @stability experimental
 */
export type AdminSocialMediaBackfill = z.infer<typeof adminSocialMediaBackfillSchema>;

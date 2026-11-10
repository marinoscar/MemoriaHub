/**
 * @packageDocumentation
 * Wire schemas of AI tagging: the tag-label vocabulary bodies and the admin backfill request.
 */
import { z } from 'zod';
import { flexibleDate } from '../primitives/index.js';

/**
 * Body of `POST /api/tag-labels`.
 *
 * @stability experimental
 */
export const createTagLabelSchema = z.object({
  name: z.string().min(1).max(100),
});

/**
 * The parsed value of {@link createTagLabelSchema}.
 *
 * @stability experimental
 */
export type CreateTagLabel = z.infer<typeof createTagLabelSchema>;

/**
 * Body of `PATCH /api/tag-labels/:id`.
 *
 * @stability experimental
 */
export const updateTagLabelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  // .default({}) so a bodyless request parses as {} (issue #289).
}).default({});

/**
 * The parsed value of {@link updateTagLabelSchema}.
 *
 * @stability experimental
 */
export type UpdateTagLabel = z.infer<typeof updateTagLabelSchema>;

/**
 * Body of `POST /api/admin/tagging/backfill`.
 *
 * @stability experimental
 */
export const adminTaggingBackfillSchema = z.object({
  from: flexibleDate.optional(),
  to: flexibleDate.optional(),
  force: z.boolean().optional().default(false),
  /**
   * Which media types to back-fill. Videos are OPT-IN: an admin used to running
   * photo backfills would otherwise dispatch an AI call for every video in the
   * library on the first run after upgrading. Deliberately no `.default()`: an
   * absent value is resolved in the service, so the default lives in one place.
   */
  mediaTypes: z.array(z.enum(['photo', 'video'])).nonempty().optional(),
  // .prefault({}) so a bodyless POST parses exactly like {} (force: false), issue #289.
}).prefault({});

/**
 * The parsed value of {@link adminTaggingBackfillSchema}.
 *
 * @stability experimental
 */
export type AdminTaggingBackfill = z.infer<typeof adminTaggingBackfillSchema>;

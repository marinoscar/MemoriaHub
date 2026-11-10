import { z } from 'zod';

/**
 * POST /api/workflows/:id/run body.
 *
 * @stability experimental
 */
export const createRunSchema = z.object({
  /** Optional per-run cap; the effective cap is min(this, options.maxItems, system ceiling). */
  maxItems: z.coerce.number().int().positive().optional(),
  // .default({}) so a bodyless POST parses as {} — see issue #289 (app.module.ts).
}).default({});

/**
 * The parsed value of {@link createRunSchema}.
 *
 * @stability experimental
 */
export type CreateRun = z.infer<typeof createRunSchema>;

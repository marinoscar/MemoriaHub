import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** POST /api/workflows/:id/run body. */
export const createRunSchema = z.object({
  /** Optional per-run cap; the effective cap is min(this, options.maxItems, system ceiling). */
  maxItems: z.coerce.number().int().positive().optional(),
  // .default({}) so a bodyless POST parses as {} — see issue #289 (app.module.ts).
}).default({});

export class CreateRunDto extends createZodDto(createRunSchema) {}

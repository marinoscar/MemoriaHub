import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Request parameters for POST /api/media/:id/enhance (spec §4.1). All fields are
 * optional — an empty body enhances with full `auto` defaults. These params are
 * persisted verbatim on the media_enhancements row (audit of what was asked) and
 * compiled deterministically into the prompt at row-creation time.
 */
export const enhanceParamsSchema = z.object({
  intent: z.enum(['auto', 'custom']).optional(),
  adjustments: z
    .object({
      color: z.boolean().optional(),
      tone: z.boolean().optional(),
      sharpness: z.boolean().optional(),
      denoise: z.boolean().optional(),
      dehaze: z.boolean().optional(),
      straighten: z.boolean().optional(),
    })
    .optional(),
  strength: z.enum(['subtle', 'balanced', 'strong']).optional(),
  preserveFaces: z.boolean().optional(),
  instructions: z.string().max(500).optional(),
  /** Optional per-call override of ai.features.enhance.model. */
  model: z.string().max(200).optional(),
});

export type EnhanceParams = z.infer<typeof enhanceParamsSchema>;

export class EnhanceParamsDto extends createZodDto(enhanceParamsSchema) {}

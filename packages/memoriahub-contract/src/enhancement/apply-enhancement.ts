import { z } from 'zod';


/**
 * Body for POST /api/media/:id/enhance/:enhancementId/apply (spec §8.4).
 *   - keep_both: create a NEW MediaItem from the staged enhanced bytes.
 *   - replace: destructively overwrite the original item's bytes.
 *
 * `acknowledgeDownscale` is the informed-consent escape hatch for the
 * `pictureEnhancement.blockReplaceOnDownscale` guard (issue #426). The two
 * replace policies are deliberately NOT the same kind of rule:
 *   - `allowReplace: false` is a HARD policy — no override exists.
 *   - `blockReplaceOnDownscale: true` is a CONFIRM-THROUGH guard — the user
 *     may pass it by explicitly acknowledging the resolution loss, which the
 *     client only offers behind an escalated confirmation dialog.
 * Without this, the guard is an absolute wall: `gpt-image-1` caps its output
 * at ~1.6 MP, so every realistic photo is downscaled and replace was
 * unreachable for every photo, forever.
 *
 * @stability experimental
 */
export const applyEnhancementSchema = z.object({
  decision: z.enum(['keep_both', 'replace']),
  acknowledgeDownscale: z.boolean().optional(),
});

/**
 * The parsed value of {@link applyEnhancementSchema}.
 *
 * @stability experimental
 */
export type ApplyEnhancement = z.infer<typeof applyEnhancementSchema>;

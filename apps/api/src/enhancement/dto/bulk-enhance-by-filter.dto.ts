import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { mediaFilterFields } from '../../media/dto/media-query.dto';
import { enhanceParamsSchema } from './enhance-params.dto';

/**
 * Request body for POST /api/media/bulk/enhance/by-filter (epic #420, issue #424).
 *
 * Composed exactly the way `AddAlbumItemsByFilterDto` is — spread the shared
 * `mediaFilterFields` shape and force `circleId` required — so a client can hand
 * the SAME filter object to either endpoint. That includes inheriting the shape's
 * query-string-oriented quirks: the boolean-ish fields (`favorite`, `missingGeo`,
 * `noFaces`, …) are `z.string().transform(...)`, i.e. they expect the literal
 * strings `"true"` / `"false"` even in a JSON body. Diverging here (accepting real
 * JSON booleans) would make the two endpoints subtly incompatible for a caller
 * that reuses one filter object across both, so the quirk is matched on purpose.
 *
 * `personId` / `personIds` / `peopleMatch` ride along in `mediaFilterFields` but
 * are NOT part of `buildMediaWhere` — they are applied separately via the
 * `wherePeople(ids, mode)` export, same as `MediaService.addAlbumItemsByFilter`.
 *
 * There is deliberately NO id array and NO client-supplied cap here: the whole
 * point of this endpoint is that the server resolves the match set. The
 * `pictureEnhancement.maxBatchSize` system setting is the only limit, enforced in
 * `MediaEnhancementService.startBatchByFilter` — which REFUSES an over-cap match
 * rather than truncating it.
 */
export const bulkEnhanceByFilterSchema = z.object({
  ...mediaFilterFields,
  // circleId is required here (not optional as in mediaFilterFields).
  circleId: z.string().uuid(),
  // One `params` object applies to every matched item, exactly as in
  // POST /api/media/bulk/enhance — a bulk enhance is a single intent applied
  // across a set, not per-item tuning.
  params: enhanceParamsSchema.optional().default({}),
});

export type BulkEnhanceByFilter = z.infer<typeof bulkEnhanceByFilterSchema>;

export class BulkEnhanceByFilterDto extends createZodDto(bulkEnhanceByFilterSchema) {}

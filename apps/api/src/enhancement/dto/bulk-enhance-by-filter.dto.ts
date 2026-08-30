import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { mediaFilterFields } from '../../media/dto/media-query.dto';
import { enhanceParamsSchema } from './enhance-params.dto';

/**
 * Request body for POST /api/media/bulk/enhance/by-filter (epic #420, issue #424).
 *
 * Composed EXACTLY like AddAlbumItemsByFilterDto: the shared `mediaFilterFields`
 * shape spread verbatim, with `circleId` overridden to required. That reuse is
 * the point — a client must be able to hand the same filter object it already
 * sends to `GET /api/media` or `POST /api/media/albums/:id/items/by-filter`
 * straight to this endpoint and get the same matched set back.
 *
 * TWO quirks inherited deliberately rather than "fixed" here:
 *
 *  1. The boolean-ish fields (`favorite`, `missingGeo`, `missingCapturedAt`,
 *     `missingCamera`, `noFaces`) are `z.string().transform(...)` — query-string
 *     oriented — even though this is a POST body, so they arrive as the STRINGS
 *     `'true'` / `'false'`. `AddAlbumItemsByFilterDto` has the identical quirk.
 *     Diverging here (accepting real JSON booleans) would mean one filter object
 *     could not be reused across the two by-filter endpoints, which is the whole
 *     reason to share the shape.
 *
 *  2. `personId` / `personIds` / `peopleMatch` ride along in `mediaFilterFields`
 *     but are NOT part of `buildMediaWhere` — people filtering is the separate
 *     `wherePeople(ids, 'all' | 'any')` builder, composed by the service.
 *
 * `params` is the SAME single-intent enhance-params object as the by-selection
 * endpoint: one set of options applies to every matched photo.
 *
 * There is deliberately NO cap in this schema (unlike `bulkEnhanceSchema`'s
 * `.max(200)` backstop on `ids`): a filter does not carry its match count, so
 * the only place the size can be checked is server-side after the count, against
 * `pictureEnhancement.maxBatchSize` — see startBatchByFilter.
 */
export const bulkEnhanceByFilterSchema = z.object({
  ...mediaFilterFields,
  // Required here, unlike the optional in the shared shape.
  circleId: z.string().uuid(),
  params: enhanceParamsSchema.optional().default({}),
});

export type BulkEnhanceByFilter = z.infer<typeof bulkEnhanceByFilterSchema>;

export class BulkEnhanceByFilterDto extends createZodDto(bulkEnhanceByFilterSchema) {}

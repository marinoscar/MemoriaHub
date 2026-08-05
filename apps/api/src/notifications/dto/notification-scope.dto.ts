import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Optional body for the two bulk endpoints (read-all / dismiss-all).
 *
 * `circleId` deliberately has NO default: an absent `circleId` means "every
 * notification for this user, across all circles".
 *
 * The whole body is optional too — all three of these are accepted and mean
 * the same unscoped thing:
 *
 *   - `fetch(url, { method: 'POST' })`   (no Content-Type, no payload at all)
 *   - `{}`
 *   - `{ circleId: undefined }`
 *
 * while `{ circleId: '<uuid>' }` scopes to one circle and a malformed
 * `circleId` still 400s.
 *
 * WHY the top-level `.default({})` is required: Fastify leaves
 * `request.body` as `undefined` when a request carries no body, Nest's
 * `@Body()` hands that `undefined` straight to the ZodValidationPipe, and
 * `z.object({...}).parse(undefined)` throws `invalid_type` no matter how
 * optional every one of its fields is. `.default({})` maps that `undefined`
 * to `{}` before the object schema ever sees it, so a genuinely bodyless
 * POST — the most natural way for a client to write "mark all as read" —
 * succeeds instead of returning 400. It also surfaces as `default: {}` in
 * the generated OpenAPI schema.
 */
export const notificationScopeSchema = z
  .object({
    circleId: z.string().uuid().optional(),
  })
  .default({});

export class NotificationScopeDto extends createZodDto(notificationScopeSchema) {}

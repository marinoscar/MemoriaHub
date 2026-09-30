import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// Push subscription wire types (epic #481, issue #483)
// =============================================================================
//
// No `userId` field anywhere: the owner is always `@CurrentUser('id')`.
// =============================================================================

/**
 * Body of POST /api/notifications/push/subscriptions — the browser's
 * `PushSubscription.toJSON()` shape, passed through unchanged.
 */
export const pushSubscribeSchema = z.object({
  /** Push service URL. Must be https — every real push service is. */
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine((v) => v.startsWith('https://'), { message: 'endpoint must be an https:// URL' }),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
  /** Unix ms, or null/absent — most push services never set one. */
  expirationTime: z.number().nullable().optional(),
});
export type PushSubscribeRequest = z.infer<typeof pushSubscribeSchema>;
export class PushSubscribeDto extends createZodDto(pushSubscribeSchema) {}

/**
 * Body of DELETE /api/notifications/push/subscriptions. A body rather than a
 * path segment: the endpoint is a long URL full of `/`.
 */
export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().min(1).max(2048),
});
export type PushUnsubscribeRequest = z.infer<typeof pushUnsubscribeSchema>;
export class PushUnsubscribeDto extends createZodDto(pushUnsubscribeSchema) {}

export interface PushSubscriptionResponse {
  id: string;
  endpoint: string;
  createdAt: string;
}

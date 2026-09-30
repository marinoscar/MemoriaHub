import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { BROADCAST_CHANNELS, BROADCAST_STATUSES } from '../broadcast-constants';

/**
 * One broadcast as returned by /api/admin/broadcasts. Timestamps are ISO 8601
 * strings. Handler return values are wrapped by the global interceptor as
 * `{ data: <this>, meta: { timestamp } }`.
 */
export const broadcastSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  ctaLabel: z.string().nullable(),
  critical: z.boolean(),
  channels: z.array(z.enum(BROADCAST_CHANNELS)),
  status: z.enum(BROADCAST_STATUSES),
  scheduledFor: z.string().nullable(),
  audienceCutoff: z.string().nullable(),
  /** Audience size frozen at the cutoff; null until sending starts. */
  recipientCount: z.number().int().nullable(),
  /** Recipients delivered so far (cumulative across resumes). */
  processedCount: z.number().int(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  canceledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z
    .object({ id: z.string().uuid(), email: z.string(), displayName: z.string().nullable() })
    .nullable(),
  canceledBy: z
    .object({ id: z.string().uuid(), email: z.string(), displayName: z.string().nullable() })
    .nullable(),
});
export class BroadcastDto extends createZodDto(broadcastSchema) {}
export type BroadcastResponse = z.infer<typeof broadcastSchema>;

export const broadcastListSchema = z.object({
  items: z.array(broadcastSchema),
  meta: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    totalItems: z.number().int(),
    totalPages: z.number().int(),
  }),
});
export class BroadcastListDto extends createZodDto(broadcastListSchema) {}
export type BroadcastListResponse = z.infer<typeof broadcastListSchema>;

export const broadcastAudienceSchema = z.object({
  /** Active users a broadcast created now would reach. */
  activeUsers: z.number().int(),
});
export class BroadcastAudienceDto extends createZodDto(broadcastAudienceSchema) {}

export const broadcastTestResultSchema = z.object({
  notificationType: z.enum(['admin_broadcast', 'admin_broadcast_critical']),
  channels: z.array(z.enum(BROADCAST_CHANNELS)),
  sentToUserId: z.string().uuid(),
  /** Null when 'email' was not selected. */
  email: z.object({ success: z.boolean(), error: z.string().nullable() }).nullable(),
});
export class BroadcastTestResultDto extends createZodDto(broadcastTestResultSchema) {}
export type BroadcastTestResult = z.infer<typeof broadcastTestResultSchema>;

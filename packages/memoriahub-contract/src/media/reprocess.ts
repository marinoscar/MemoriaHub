import { z } from 'zod';

/**
 * Wire schema `reprocessBodySchema`.
 *
 * @stability experimental
 */
export const reprocessBodySchema = z.object({
  circleId: z.string().uuid().optional(),
  all: z.boolean().optional(),
}).default({});

/**
 * Wire schema `reprocessStuckBodySchema`.
 *
 * @stability experimental
 */
export const reprocessStuckBodySchema = z.object({
  olderThanMinutes: z.number().int().positive().optional(),
}).default({});

/**
 * Wire schema `reprocessFailedBodySchema`.
 *
 * @stability experimental
 */
export const reprocessFailedBodySchema = z.object({
  limit: z.number().int().positive().optional(),
}).default({});

/**
 * The parsed value of {@link reprocessBodySchema}.
 *
 * @stability experimental
 */
export type ReprocessBody = z.infer<typeof reprocessBodySchema>;

/**
 * The parsed value of {@link reprocessStuckBodySchema}.
 *
 * @stability experimental
 */
export type ReprocessStuckBody = z.infer<typeof reprocessStuckBodySchema>;

/**
 * The parsed value of {@link reprocessFailedBodySchema}.
 *
 * @stability experimental
 */
export type ReprocessFailedBody = z.infer<typeof reprocessFailedBodySchema>;

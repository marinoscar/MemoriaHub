import { z } from 'zod';


/**
 * Wire schema `resolveBurstSchema`.
 *
 * @stability experimental
 */
export const resolveBurstSchema = z.object({
  keepIds: z.array(z.string().uuid()).min(1),
  action: z.enum(['archive', 'trash']),
});

/**
 * The parsed value of {@link resolveBurstSchema}.
 *
 * @stability experimental
 */
export type ResolveBurst = z.infer<typeof resolveBurstSchema>;

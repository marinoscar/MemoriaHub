import { z } from 'zod';


/**
 * Wire schema `resolveDuplicateSchema`.
 *
 * @stability experimental
 */
export const resolveDuplicateSchema = z.object({
  keepIds: z.array(z.string().uuid()).min(1),
  action: z.enum(['archive', 'trash']),
});

/**
 * The parsed value of {@link resolveDuplicateSchema}.
 *
 * @stability experimental
 */
export type ResolveDuplicate = z.infer<typeof resolveDuplicateSchema>;

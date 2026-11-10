import { z } from 'zod';


/**
 * Wire schema `attachTagsSchema`.
 *
 * @stability experimental
 */
export const attachTagsSchema = z.object({
  names: z
    .array(z.string().min(1).max(128))
    .min(1, 'At least one tag name is required'),
});

/**
 * The parsed value of {@link attachTagsSchema}.
 *
 * @stability experimental
 */
export type AttachTags = z.infer<typeof attachTagsSchema>;

import { z } from 'zod';

/**
 * Body of `POST /api/people/merge`: reassign every face of `sourceId` to `targetId`.
 *
 * @stability experimental
 */
export const mergePeopleSchema = z
  .object({
    sourceId: z.string().uuid(),
    targetId: z.string().uuid(),
  })
  .refine((d) => d.sourceId !== d.targetId, {
    message: 'sourceId and targetId must be different',
    path: ['targetId'],
  });

/**
 * The parsed value of {@link mergePeopleSchema}.
 *
 * @stability experimental
 */
export type MergePeople = z.infer<typeof mergePeopleSchema>;

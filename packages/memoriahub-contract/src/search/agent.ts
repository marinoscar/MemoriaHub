import { z } from 'zod';

/**
 * Wire schema `agentMessageSchema`.
 *
 * @stability experimental
 */
export const agentMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(10000),
});

/**
 * Wire schema `agentTurnSchema`.
 *
 * @stability experimental
 */
export const agentTurnSchema = z.object({
  circleId: z.string().uuid(),
  messages: z
    .array(agentMessageSchema)
    .min(1)
    .refine((msgs) => msgs[msgs.length - 1].role === 'user', {
      message: 'Last message must have role "user"',
    }),
});

/**
 * The parsed value of {@link agentMessageSchema}.
 *
 * @stability experimental
 */
export type AgentMessage = z.infer<typeof agentMessageSchema>;

/**
 * The parsed value of {@link agentTurnSchema}.
 *
 * @stability experimental
 */
export type AgentTurn = z.infer<typeof agentTurnSchema>;

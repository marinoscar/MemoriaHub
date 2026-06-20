import {
  Controller,
  Post,
  Body,
  HttpCode,
  Logger,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { SearchAgentService } from './search-agent.service';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { CircleMembershipService } from '../../circles/circle-membership.service';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const agentMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(10000),
});

const agentTurnSchema = z.object({
  circleId: z.string().uuid(),
  messages: z
    .array(agentMessageSchema)
    .min(1)
    .refine((msgs) => msgs[msgs.length - 1].role === 'user', {
      message: 'Last message must have role "user"',
    }),
});

export class AgentTurnDto extends createZodDto(agentTurnSchema) {}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('Search')
@ApiBearerAuth('JWT-auth')
@Controller('search')
export class SearchAgentController {
  private readonly logger = new Logger(SearchAgentController.name);

  constructor(
    private readonly searchAgentService: SearchAgentService,
    private readonly circleMembership: CircleMembershipService,
  ) {}

  /**
   * POST /api/search/agent
   *
   * Stateless agentic search endpoint. The client sends the full conversation
   * history (all prior turns) plus the new user message as the last entry.
   * The server streams SSE events: token, tool_call, results, done, error.
   */
  @Post('agent')
  @Auth({ permissions: [PERMISSIONS.SEARCH_USE] })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Stateless agentic media search (SSE)',
    description:
      'Send the full conversation history. Streams Server-Sent Events. ' +
      'Event types: token, tool_call, results, done, error. ' +
      'No server-side persistence — client owns the history.',
  })
  @ApiResponse({ status: 200, description: 'SSE stream (text/event-stream)' })
  @ApiResponse({ status: 400, description: 'AI not configured, invalid messages, or validation error' })
  @ApiResponse({ status: 403, description: 'Not a circle member or insufficient permissions' })
  async streamAgent(
    @Body() dto: AgentTurnDto,
    @CurrentUser() user: RequestUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Verify circle membership before opening SSE stream
    await this.circleMembership.assertCircleAccess(
      user.id,
      dto.circleId,
      user.permissions,
      'viewer',
    );

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      for await (const event of this.searchAgentService.streamTurn({
        circleId: dto.circleId,
        messages: dto.messages,
        userId: user.id,
        permissions: user.permissions,
      })) {
        reply.raw.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }

      reply.raw.write(`event: done\ndata: ${JSON.stringify({})}\n\n`);
    } catch (err) {
      this.logger.error(`SSE stream error: ${(err as Error).message}`);
      reply.raw.write(
        `event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`,
      );
    } finally {
      reply.raw.end();
    }
  }
}

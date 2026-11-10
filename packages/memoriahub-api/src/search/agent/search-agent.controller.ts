import {
  Controller,
  Inject,
  Post,
  Body,
  HttpCode,
  Logger,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { agentMessageSchema, agentTurnSchema } from '@marinoscar/memoriahub-contract/search';

import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../../core/index.js';
import { MEMORIAHUB_ACCESS, type MemoriahubAccessPort } from '../../ports/index.js';
import { SEARCH_PERMISSIONS as PERMISSIONS } from '../constants.js';
import { SearchAgentService } from './search-agent.service.js';

/**
 * The part of the Fastify reply the SSE stream writes to. Structural: the package imports no
 * Fastify type, the host runs the Fastify adapter.
 */
interface SseReply {
  raw: { writeHead(status: number, headers: Record<string, string>): unknown; write(chunk: string): unknown; end(): unknown };
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------



/**
 * The body of `POST /api/search/agent`.
 *
 * @stability experimental
 */
export class AgentTurnDto extends createZodDto(agentTurnSchema) {}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * `POST /api/search/agent`, the stateless agentic search over Server-Sent Events; mounted by the host
 * in its own module. The route owns the response (`@Res()`): the host's response interceptor skips it
 * (`APP_STREAM_PATHS`).
 *
 * @stability experimental
 */
@ApiTags('Search')
@ApiBearerAuth('JWT-auth')
@Controller('search')
export class SearchAgentController {
  private readonly logger = new Logger(SearchAgentController.name);

  constructor(
    private readonly searchAgentService: SearchAgentService,
    @Inject(MEMORIAHUB_ACCESS) private readonly access: MemoriahubAccessPort,
  ) {}

  /**
   * POST /api/search/agent
   *
   * Stateless agentic search endpoint. The client sends the full conversation
   * history (all prior turns) plus the new user message as the last entry.
   * The server streams SSE events: token, tool_call, results, done, error.
   */
  @Post('agent')
  @MemoriahubAuth({ permissions: [PERMISSIONS.SEARCH_USE] })
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
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
    @Res() reply: SseReply,
  ): Promise<void> {
    // Verify circle membership before opening SSE stream
    await this.access.requireOwnerRole(
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

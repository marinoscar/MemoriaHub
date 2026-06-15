import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  Logger,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ConversationsService } from './conversations.service';
import { SearchAgentService, AgentAccumulator } from '../agent/search-agent.service';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const createConversationSchema = z.object({
  circleId: z.string().uuid(),
});

export class CreateConversationDto extends createZodDto(createConversationSchema) {}

const listConversationsQuerySchema = z.object({
  circleId: z.string().uuid(),
  favorite: z
    .string()
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
  archived: z
    .string()
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export class ListConversationsQueryDto extends createZodDto(listConversationsQuerySchema) {}

const updateConversationSchema = z.object({
  title: z.string().max(200).optional(),
  favorite: z.boolean().optional(),
});

export class UpdateConversationDto extends createZodDto(updateConversationSchema) {}

const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000),
});

export class SendMessageDto extends createZodDto(sendMessageSchema) {}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('Search Conversations')
@ApiBearerAuth('JWT-auth')
@Controller('search/conversations')
export class ConversationsController {
  private readonly logger = new Logger(ConversationsController.name);

  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly searchAgentService: SearchAgentService,
  ) {}

  @Post()
  @Auth({ permissions: [PERMISSIONS.SEARCH_USE] })
  @ApiOperation({ summary: 'Create a new search conversation' })
  @ApiResponse({ status: 201, description: 'Conversation created' })
  @ApiResponse({ status: 400, description: 'AI search not configured or invalid input' })
  @ApiResponse({ status: 403, description: 'Not a circle member or insufficient permissions' })
  async create(
    @Body() dto: CreateConversationDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.conversationsService.create(user.id, dto.circleId, user.permissions);
  }

  @Get()
  @Auth({ permissions: [PERMISSIONS.SEARCH_USE] })
  @ApiOperation({ summary: 'List search conversations for the current user' })
  @ApiResponse({ status: 200, description: 'Paginated conversation list' })
  async list(
    @Query() query: ListConversationsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.conversationsService.list(user.id, {
      circleId: query.circleId,
      favorite: query.favorite as boolean | undefined,
      archived: query.archived as boolean | undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.SEARCH_USE] })
  @ApiOperation({ summary: 'Get a single conversation with its messages' })
  @ApiResponse({ status: 200, description: 'Conversation detail' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.conversationsService.findOne(id, user.id);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.SEARCH_USE] })
  @ApiOperation({ summary: 'Update conversation title or favorite flag' })
  @ApiResponse({ status: 200, description: 'Updated conversation' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateConversationDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.conversationsService.update(id, user.id, dto);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.SEARCH_USE] })
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a conversation' })
  @ApiResponse({ status: 204, description: 'Conversation deleted' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async softDelete(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.conversationsService.softDelete(id, user.id);
  }

  @Post(':id/messages')
  @Auth({ permissions: [PERMISSIONS.SEARCH_USE] })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send a message and stream the AI response via SSE',
    description:
      'Streams Server-Sent Events. Event types: token, tool_call, results, done, error.',
  })
  @ApiResponse({ status: 200, description: 'SSE stream (text/event-stream)' })
  @ApiResponse({ status: 400, description: 'AI not configured or invalid input' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async streamMessage(
    @Param('id') id: string,
    @Body() body: SendMessageDto,
    @CurrentUser() user: RequestUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const conversation = await this.conversationsService.findOne(id, user.id);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    await this.conversationsService.addUserMessage(id, body.content);

    const accumulator: AgentAccumulator = {
      finalText: '',
      toolCalls: [],
      toolResults: [],
    };

    try {
      for await (const event of this.searchAgentService.streamTurn({
        conversation,
        userContent: body.content,
        userId: user.id,
        permissions: user.permissions,
        accumulator,
      })) {
        reply.raw.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }

      // Persist the assistant message
      const assistantMsg = await this.conversationsService.addAssistantMessage(
        id,
        accumulator.finalText,
        accumulator.toolCalls.length ? accumulator.toolCalls : undefined,
        accumulator.toolResults.length ? accumulator.toolResults : undefined,
      );

      await this.conversationsService.touchUpdatedAt(id);

      // Send the done event with the real persisted messageId
      reply.raw.write(
        `event: done\ndata: ${JSON.stringify({ messageId: assistantMsg.id })}\n\n`,
      );

      // Auto-title the conversation if it has no title yet
      if (!conversation.title) {
        const fresh = await this.conversationsService.findOne(id, user.id);
        const title = await this.conversationsService.autoTitle(fresh);
        if (title) {
          await this.conversationsService.update(id, user.id, { title });
        }
      }
    } catch (err) {
      this.logger.error(`SSE stream error for conversation ${id}: ${(err as Error).message}`);
      reply.raw.write(
        `event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`,
      );
    } finally {
      reply.raw.end();
    }
  }
}

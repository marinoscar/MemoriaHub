import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { Prisma, SearchConversation, SearchMessage } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CircleMembershipService } from '../../circles/circle-membership.service';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { AiProviderRegistry } from '../../ai/providers/ai-provider.registry';
import { ChatMessage } from '../../ai/providers/ai-provider.interface';

export interface ConversationListResult {
  data: SearchConversation[];
  meta: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembership: CircleMembershipService,
    private readonly aiSettings: AiSettingsService,
    private readonly registry: AiProviderRegistry,
  ) {}

  async create(
    userId: string,
    circleId: string,
    permissions: string[],
  ): Promise<SearchConversation> {
    await this.circleMembership.assertCircleAccess(userId, circleId, permissions, 'viewer');

    const settings = await this.aiSettings.getSettings();
    const provider = settings.features.search.provider;
    const model = settings.features.search.model;

    if (!provider || !model) {
      throw new BadRequestException(
        'AI search is not configured. An admin must configure the AI provider and model in AI Settings.',
      );
    }

    return this.prisma.searchConversation.create({
      data: { userId, circleId, provider, model },
    });
  }

  async list(
    userId: string,
    params: {
      circleId: string;
      favorite?: boolean;
      archived?: boolean;
      page: number;
      pageSize: number;
    },
  ): Promise<ConversationListResult> {
    const { circleId, favorite, archived, page, pageSize } = params;

    const where: Prisma.SearchConversationWhereInput = {
      userId,
      circleId,
      deletedAt: null,
    };

    if (favorite === true) {
      where.favorite = true;
    }

    if (archived === true) {
      where.archivedAt = { not: null };
    } else if (archived === false) {
      where.archivedAt = null;
    }

    const skip = (page - 1) * pageSize;

    const [data, totalItems] = await Promise.all([
      this.prisma.searchConversation.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.searchConversation.count({ where }),
    ]);

    return {
      data,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  async findOne(
    id: string,
    userId: string,
  ): Promise<SearchConversation & { messages: SearchMessage[] }> {
    const conv = await this.prisma.searchConversation.findFirst({
      where: { id, userId, deletedAt: null },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });

    if (!conv) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    return conv;
  }

  async update(
    id: string,
    userId: string,
    dto: { title?: string; favorite?: boolean },
  ): Promise<SearchConversation> {
    await this.findOne(id, userId); // throws NotFoundException if not found
    return this.prisma.searchConversation.update({
      where: { id },
      data: { ...dto },
    });
  }

  async softDelete(id: string, userId: string): Promise<void> {
    await this.findOne(id, userId); // throws NotFoundException if not found
    await this.prisma.searchConversation.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async addUserMessage(conversationId: string, content: string): Promise<SearchMessage> {
    return this.prisma.searchMessage.create({
      data: { conversationId, role: 'user', content },
    });
  }

  async addAssistantMessage(
    conversationId: string,
    content: string,
    toolCalls?: unknown,
    toolResults?: unknown,
  ): Promise<SearchMessage> {
    return this.prisma.searchMessage.create({
      data: {
        conversationId,
        role: 'assistant',
        content,
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        ...(toolResults !== undefined ? { toolResults } : {}),
      },
    });
  }

  async touchUpdatedAt(conversationId: string): Promise<void> {
    await this.prisma.searchConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
  }

  async autoTitle(
    conversation: SearchConversation & { messages: SearchMessage[] },
  ): Promise<string | null> {
    try {
      const settings = await this.aiSettings.getSettings();
      const providerKey = settings.features.search.provider;
      const model = settings.features.search.model;
      if (!providerKey || !model) return null;

      const creds = await this.aiSettings.resolveCredentials(providerKey);
      const provider = this.registry.get(providerKey);

      const firstUserMsg = conversation.messages.find((m) => m.role === 'user');
      const content = firstUserMsg?.content ?? 'search conversation';

      const titlePrompt: ChatMessage[] = [
        {
          role: 'user',
          content: `Generate a concise title (6 words or fewer) for a media search conversation that started with: "${content}". Reply with only the title, no punctuation.`,
        },
      ];

      let title = '';
      for await (const event of provider.chat(creds, { model, messages: titlePrompt })) {
        if (event.type === 'text') title += event.text;
      }

      return title.trim().slice(0, 80) || null;
    } catch (err) {
      this.logger.warn(`autoTitle failed: ${(err as Error).message}`);
      return null;
    }
  }
}

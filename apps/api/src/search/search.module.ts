import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { AiModule } from '../ai/ai.module';
import { SearchAgentService } from './agent/search-agent.service';
import { ConversationsService } from './conversations/conversations.service';
import { ConversationsController } from './conversations/conversations.controller';
import { ConversationLifecycleTask } from './tasks/conversation-lifecycle.task';

@Module({
  imports: [PrismaModule, CirclesModule, AiModule],
  controllers: [SearchController, ConversationsController],
  providers: [SearchService, SearchAgentService, ConversationsService, ConversationLifecycleTask],
  exports: [SearchService, SearchAgentService, ConversationsService],
})
export class SearchModule {}

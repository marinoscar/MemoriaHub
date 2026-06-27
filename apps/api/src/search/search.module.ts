import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchAgentController } from './agent/search-agent.controller';
import { SearchService } from './search.service';
import { SemanticSearchService } from './semantic-search.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { AiModule } from '../ai/ai.module';
import { SearchAgentService } from './agent/search-agent.service';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [PrismaModule, CirclesModule, AiModule, MediaModule],
  controllers: [SearchController, SearchAgentController],
  providers: [SearchService, SemanticSearchService, SearchAgentService],
  exports: [SearchService, SemanticSearchService, SearchAgentService],
})
export class SearchModule {}

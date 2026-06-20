import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchAgentController } from './agent/search-agent.controller';
import { SearchService } from './search.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CirclesModule } from '../circles/circles.module';
import { AiModule } from '../ai/ai.module';
import { SearchAgentService } from './agent/search-agent.service';

@Module({
  imports: [PrismaModule, CirclesModule, AiModule],
  controllers: [SearchController, SearchAgentController],
  providers: [SearchService, SearchAgentService],
  exports: [SearchService, SearchAgentService],
})
export class SearchModule {}

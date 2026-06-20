import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { InsightsService } from './insights.service';
import { InsightsRefreshTask } from './insights-refresh.task';
import { InsightsController } from './insights.controller';
import { StorageInsightsHandler } from './storage-insights.handler';

@Module({
  imports: [PrismaModule, SettingsModule, EnrichmentModule],
  controllers: [InsightsController],
  providers: [InsightsService, InsightsRefreshTask, StorageInsightsHandler],
  exports: [InsightsService],
})
export class InsightsModule {}

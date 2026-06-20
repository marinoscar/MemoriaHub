import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { InsightsService } from './insights.service';
import { InsightsRefreshTask } from './insights-refresh.task';
import { InsightsController } from './insights.controller';

@Module({
  imports: [PrismaModule, SettingsModule],
  controllers: [InsightsController],
  providers: [InsightsService, InsightsRefreshTask],
  exports: [InsightsService],
})
export class InsightsModule {}

import { Module } from '@nestjs/common';
import { EnrichmentHandlerRegistry } from './enrichment-handler.registry';
import { EnrichmentJobService } from './enrichment-job.service';
import { EnrichmentJobWorker } from './enrichment-job.worker';
import { EnrichmentClaimService } from './enrichment-claim.service';
import { EnrichmentTerminalService } from './enrichment-terminal.service';
import { EnrichmentAdminService } from './enrichment-admin.service';
import { EnrichmentAdminController } from './enrichment-admin.controller';
import { EnrichmentStuckResetTask } from './enrichment-stuck-reset.task';
import { TempFileJanitorTask } from './temp-file-janitor.task';
import { ProviderThrottleService } from './provider-throttle.service';
import { JobHistoryPurgeHandler } from './job-history-purge.handler';
import { JobHistoryPurgeTask } from './job-history-purge.task';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [PrismaModule, SettingsModule],
  controllers: [EnrichmentAdminController],
  providers: [
    EnrichmentHandlerRegistry,
    EnrichmentJobService,
    EnrichmentJobWorker,
    EnrichmentClaimService,
    EnrichmentTerminalService,
    EnrichmentAdminService,
    EnrichmentStuckResetTask,
    TempFileJanitorTask,
    ProviderThrottleService,
    JobHistoryPurgeHandler,
    JobHistoryPurgeTask,
  ],
  exports: [
    EnrichmentJobService,
    EnrichmentHandlerRegistry,
    EnrichmentClaimService,
    EnrichmentTerminalService,
    EnrichmentAdminService,
  ],
})
export class EnrichmentModule {}

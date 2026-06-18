import { Module } from '@nestjs/common';
import { EnrichmentHandlerRegistry } from './enrichment-handler.registry';
import { EnrichmentJobService } from './enrichment-job.service';
import { EnrichmentJobWorker } from './enrichment-job.worker';
import { EnrichmentAdminService } from './enrichment-admin.service';
import { EnrichmentAdminController } from './enrichment-admin.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [EnrichmentAdminController],
  providers: [EnrichmentHandlerRegistry, EnrichmentJobService, EnrichmentJobWorker, EnrichmentAdminService],
  exports: [EnrichmentJobService, EnrichmentHandlerRegistry],
})
export class EnrichmentModule {}

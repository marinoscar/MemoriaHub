import { Module } from '@nestjs/common';
import { EnrichmentHandlerRegistry } from './enrichment-handler.registry';
import { EnrichmentJobService } from './enrichment-job.service';
import { EnrichmentJobWorker } from './enrichment-job.worker';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [EnrichmentHandlerRegistry, EnrichmentJobService, EnrichmentJobWorker],
  exports: [EnrichmentJobService, EnrichmentHandlerRegistry],
})
export class EnrichmentModule {}

import { Module } from '@nestjs/common';
import { NodesService } from './nodes.service';
import { NodesController } from './nodes.controller';
import { NodesAdminController } from './nodes-admin.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [PrismaModule, EnrichmentModule, StorageModule],
  controllers: [NodesController, NodesAdminController],
  providers: [NodesService],
})
export class NodesModule {}

// =============================================================================
// Memories Module (epic #300, issue #302)
// =============================================================================
//
// Owns the Memories generation plumbing: the hourly per-circle scheduling cron
// and the (v1 no-op) `memory_generation` enrichment handler. Later issues in the
// epic add curators (#303–#305), AI titles (#306), the read API (#307) and the
// email digest (#311) here.
//
// Minimal-template module (mirrors InsightsModule): PrismaModule for DB access,
// SettingsModule for the cached feature-flag/settings reads, EnrichmentModule
// for the job service and the handler registry.
// =============================================================================

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { MemoriesGenerationTask } from './memories-generation.task';
import { MemoryGenerationHandler } from './memory-generation.handler';

@Module({
  imports: [PrismaModule, SettingsModule, EnrichmentModule],
  providers: [MemoriesGenerationTask, MemoryGenerationHandler],
  exports: [MemoriesGenerationTask],
})
export class MemoriesModule {}

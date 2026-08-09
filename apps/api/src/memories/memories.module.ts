// =============================================================================
// Memories Module (epic #300, issue #302)
// =============================================================================
//
// Owns the Memories generation plumbing: the hourly per-circle scheduling cron,
// the `memory_generation` enrichment handler, the shared curation engine and the
// curator registry. Later issues in the epic add more curators (#304–#305), AI
// titles (#306), the read API (#307) and the email digest (#311) here.
//
// Minimal-template module (mirrors InsightsModule): PrismaModule for DB access,
// SettingsModule for the cached feature-flag/settings reads, EnrichmentModule
// for the job service and the handler registry.
//
// THE CURATOR REGISTRY is provided as an injected array under the
// MEMORY_CURATORS token (see curators/memory-curators.provider.ts) rather than
// hard-coded in the handler, so a new curator is a provider + one entry in that
// factory and nothing else changes.
// =============================================================================

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { AiModule } from '../ai/ai.module';
import { MemoryTitleService } from './titles/memory-title.service';
import { MemoriesGenerationTask } from './memories-generation.task';
import { MemoryGenerationHandler } from './memory-generation.handler';
import { MemoryCurationService } from './curation/memory-curation.service';
import { OnThisDayCurator } from './curators/on-this-day.curator';
import { TripCurator } from './curators/trip.curator';
import { PersonHighlightsCurator } from './curators/person-highlights.curator';
import { PersonOverYearsCurator } from './curators/person-over-years.curator';
import { ThemeCurator } from './curators/theme.curator';
import { SeasonalCurator } from './curators/seasonal.curator';
import { YearInReviewCurator } from './curators/year-in-review.curator';
import { memoryCuratorsProvider } from './curators/memory-curators.provider';

@Module({
  // AiModule supplies AiSettingsService (ai.features.memories + the decrypted
  // credential) and AiProviderRegistry to MemoryTitleService (#306). The edge
  // points one way only — AiModule imports SettingsModule and nothing else —
  // so there is no cycle to break.
  imports: [PrismaModule, SettingsModule, EnrichmentModule, AiModule],
  providers: [
    MemoriesGenerationTask,
    MemoryGenerationHandler,
    MemoryCurationService,
    MemoryTitleService,
    OnThisDayCurator,
    TripCurator,
    PersonHighlightsCurator,
    PersonOverYearsCurator,
    ThemeCurator,
    SeasonalCurator,
    YearInReviewCurator,
    memoryCuratorsProvider,
  ],
  exports: [MemoriesGenerationTask, MemoryCurationService],
})
export class MemoriesModule {}

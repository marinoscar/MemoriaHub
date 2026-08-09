// =============================================================================
// Memories Module (epic #300, issue #302)
// =============================================================================
//
// Owns the Memories generation plumbing: the hourly per-circle scheduling cron,
// the `memory_generation` enrichment handler, the shared curation engine and the
// curator registry. Later issues in the epic add more curators (#304–#305), AI
// titles (#306) and the email digest (#311) here. Issue #307 added the read/act
// HTTP surface (MemoriesController + MemoriesService) under `api/`.
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
import { CirclesModule } from '../circles/circles.module';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailModule } from '../email/email.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { MemoriesNotificationService } from './notifications/memories-notification.service';
import { MemoryDigestService } from './digest/memory-digest.service';
import { MemoryDigestHandler } from './digest/memory-digest.handler';
import { MemoryDigestTask } from './digest/memory-digest.task';
import { PublicMemoryDigestController } from './digest/public-memory-digest.controller';
import { AdminMemoriesController } from './admin/admin-memories.controller';
import { MemoryBackfillService } from './admin/memory-backfill.service';
import { MemoriesController } from './api/memories.controller';
import { MemoriesService } from './api/memories.service';
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
  //
  // #307's API layer adds two edges: CirclesModule (CircleMembershipService,
  // the per-circle role checks) and MediaModule (MediaThumbnailService for
  // batched signing, MediaService for the album path save-as-album reuses
  // rather than duplicating). Both point one way — neither imports
  // MemoriesModule — so there is no cycle and no forwardRef.
  //
  // #311 adds NotificationsModule for MemoriesNotificationService. That edge
  // points INTO notifications exactly like MediaModule's and WorkflowsModule's;
  // NotificationsModule itself still imports NOTHING, which is the load-bearing
  // property that keeps the module graph acyclic (see its header).
  //
  // #311's digest adds two more one-way edges: EmailModule (EmailService, the
  // fire-and-forget send path shared with the circle-invitation mails) and
  // StorageProvidersModule (StorageProviderResolver, so the public digest-image
  // route can stream thumbnail bytes the way PublicShareController does).
  // Neither imports MemoriesModule, so no cycle and no forwardRef. The
  // unsubscribe write reuses SettingsModule's UserSettingsService, already
  // imported above.
  imports: [
    PrismaModule,
    SettingsModule,
    EnrichmentModule,
    AiModule,
    CirclesModule,
    MediaModule,
    NotificationsModule,
    EmailModule,
    StorageProvidersModule,
  ],
  // #315's AdminMemoriesController is mounted here rather than in a separate
  // admin module: it needs MemoryBackfillService and MEMORY_GENERATION_JOB_TYPE,
  // both of which live in this module, and every other feature's admin backfill
  // controller (AdminBurstController, AdminLocationInferenceController) sits in
  // its own feature module for the same reason.
  controllers: [MemoriesController, AdminMemoriesController, PublicMemoryDigestController],
  providers: [
    MemoriesService,
    MemoryBackfillService,
    MemoriesNotificationService,
    MemoryDigestService,
    MemoryDigestHandler,
    MemoryDigestTask,
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
  exports: [
    MemoriesGenerationTask,
    MemoryBackfillService,
    MemoryCurationService,
    MemoriesService,
    MemoryDigestTask,
    MemoryDigestService,
  ],
})
export class MemoriesModule {}

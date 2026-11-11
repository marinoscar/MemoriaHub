// =============================================================================
// Memories Module (epic #300, issue #302; moved into the package by RETRO-J8, #619)
// =============================================================================
//
// Owns the Memories generation plumbing: the hourly per-circle scheduling cron, the `memory_generation`
// handler, the shared curation engine and the curator registry, AI titles, the e-mail digest (cron,
// handler, service, capability tokens), the `memories_ready` producer, the admin backfill, and the read
// and act API (service). It reaches the outside only through the host ports of
// `@marinoscar/memoriahub-api/ports` and the options of `MemoriesModule.forRoot`.
//
// THE CONTROLLERS ARE THE HOST'S TO MOUNT. `forRoot()` registers none: the host mounts the exported
// `MemoriesController`, `AdminMemoriesController` and `PublicMemoryDigestController` in its own module
// (the route prefix, the guards and the host's global filters are its own).
//
// THE CURATOR REGISTRY is provided as an injected array under the MEMORY_CURATORS token (see
// curators/memory-curators.provider.ts) rather than hard-coded in the handler, so a new curator is a
// provider + one entry in that factory and nothing else changes.
// =============================================================================

import { Module, type DynamicModule, type ModuleMetadata, type Provider } from '@nestjs/common';

import { MediaModule } from '../media/index.js';
import { MemoryBackfillService } from './admin/memory-backfill.service.js';
import { MemoriesService } from './api/memories.service.js';
import { MemoryCurationService } from './curation/memory-curation.service.js';
import { OnThisDayCurator } from './curators/on-this-day.curator.js';
import { PersonHighlightsCurator } from './curators/person-highlights.curator.js';
import { PersonOverYearsCurator } from './curators/person-over-years.curator.js';
import { SeasonalCurator } from './curators/seasonal.curator.js';
import { ThemeCurator } from './curators/theme.curator.js';
import { TripCurator } from './curators/trip.curator.js';
import { YearInReviewCurator } from './curators/year-in-review.curator.js';
import { memoryCuratorsProvider } from './curators/memory-curators.provider.js';
import { DigestTokenService } from './digest/digest-token.util.js';
import { MemoryDigestHandler } from './digest/memory-digest.handler.js';
import { MemoryDigestService } from './digest/memory-digest.service.js';
import { MemoryDigestTask } from './digest/memory-digest.task.js';
import { MEMORIES_OPTIONS, type MemoriesHostOptions } from './host/memories-options.js';
import { MemoriesGenerationTask } from './memories-generation.task.js';
import { MemoriesSettingsService } from './memories-settings.util.js';
import { MemoryGenerationHandler } from './memory-generation.handler.js';
import { MemoriesNotificationService } from './notifications/memories-notification.service.js';
import { MemoryTitleService } from './titles/memory-title.service.js';

/**
 * Options of {@link MemoriesModule.forRoot}.
 *
 * @stability experimental
 */
export interface MemoriesModuleForRootOptions extends MemoriesHostOptions {
  /**
   * Providers the host supplies for the tokens the slice injects and that are not ports: `MEMORIES_ALBUMS`
   * (required, save-as-album over the host's album code), `MEMORIES_EMAIL_READINESS` and `MEMORIES_GENERATION_HOOK` (both optional; the second is told of
   * a run that created memories).
   */
  providers: Provider[];
  /** Modules the host's providers need. */
  imports?: ModuleMetadata['imports'];
}

/**
 * The memories slice (RETRO-J8, #619): curation, the seven curators, AI titles, the digest, the
 * `memories_ready` notification and the read API behind the host ports.
 *
 * Import it ONCE in the host. The two job handlers (`memory_generation`, `memory_digest`) register
 * themselves with the queue on start; the two crons enqueue only.
 *
 * @stability experimental
 */
@Module({})
export class MemoriesModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module. The result is cached, so every `forRoot()` call names the same module instance.
   *
   * @param options - the host's providers and the options of the slice.
   */
  static forRoot(options: MemoriesModuleForRootOptions): DynamicModule {
    const { providers: hostProviders, imports = [], ...rest } = options;
    MemoriesModule.root ??= {
      module: MemoriesModule,
      imports: [MediaModule.forRoot(), ...imports],
      providers: [
        ...hostProviders,
        { provide: MEMORIES_OPTIONS, useValue: rest satisfies MemoriesHostOptions },
        MemoriesSettingsService,
        DigestTokenService,
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
        MemoriesSettingsService,
        DigestTokenService,
        MemoriesGenerationTask,
        MemoryBackfillService,
        MemoryCurationService,
        MemoriesService,
        MemoryDigestTask,
        MemoryDigestService,
        MemoriesNotificationService,
        MemoryTitleService,
      ],
    };
    return MemoriesModule.root;
  }
}

import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { USER_DATA_DB, type UserDataDbPort, type UserDataSystemReason } from '@marinoscar/platform-api/user-data';

import { OwnerAccessModule } from '../sharing/owner-access.module';
import { MediaModule } from '../../media/media.module';
import { PrismaSystemService } from '../../prisma/prisma-system.service';
import { MediaProcessingModule } from '../../media-processing/media-processing.module';
import { bindMemoriaHubFactoryResetDeps } from './factory-reset.steps';
import { MEMORIAHUB_PURGE_HANDLERS } from './memoriahub-purge.handlers';
import { MemoriaHubUserDataService } from './memoriahub-user-data.service';

// =============================================================================
// The user-data slice's host port and MemoriaHub's purge machinery (RETRO-H1, #591)
// =============================================================================
//
// USER_DATA_DB -> `PrismaSystemService.runAsSystem` / `asSystem` (the system client's separate
// pool, RETRO-D1): every statement runs in a transaction whose FIRST statement is
// `set_config('app.rls_bypass', 'on', true)` (transaction-local, the platform's
// RLS contract). The purge must reach a user's rows in every row-level-security
// table (`storage_objects` among them) and every statement the slice sends
// carries an explicit owner filter, so lifting RLS widens nothing.
//
// Also here, because only the user-data slice needs them:
//   - `MemoriaHubUserDataService`, the personal-circle purges, the removal hook's
//     work and the factory reset's storage sweep (storage routed per row through
//     `StorageProviderResolver` over the platform storage slice, media through `MediaService`);
//   - the five delegated purge job handlers (`memoriahub-purge.handlers.ts`);
//   - `MemoriaHubFactoryResetBinding`, which hands the registered factory reset
//     steps the service they cannot inject.
//
// Not @Global: `UserDataModule.forRoot({ imports: [UserDataHostModule] })` is the
// only importer. The removal hook resolves the service through the platform's
// `ModuleRef` lookup (`strict: false`), which finds it here.
// =============================================================================

/** Binds the factory reset steps' service once the container is up. */
@Injectable()
export class MemoriaHubFactoryResetBinding implements OnModuleInit {
  constructor(private readonly service: MemoriaHubUserDataService) {}

  onModuleInit(): void {
    bindMemoriaHubFactoryResetDeps({ service: this.service });
  }
}

@Module({
  imports: [MediaModule, MediaProcessingModule, OwnerAccessModule],
  providers: [
    MemoriaHubUserDataService,
    MemoriaHubFactoryResetBinding,
    ...MEMORIAHUB_PURGE_HANDLERS,
    {
      provide: USER_DATA_DB,
      inject: [PrismaSystemService],
      useFactory: (system: PrismaSystemService): UserDataDbPort => ({
        runAsSystem: <R>(
          reason: UserDataSystemReason,
          fn: (tx: unknown) => Promise<R>,
          options?: { timeout?: number },
        ): Promise<R> => system.runAsSystem(reason, fn as never, options) as Promise<R>,
        system: (reason: UserDataSystemReason) => system.asSystem(reason),
      }),
    },
  ],
  exports: [USER_DATA_DB, MemoriaHubUserDataService],
})
export class UserDataHostModule {}

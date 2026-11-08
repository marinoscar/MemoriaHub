import { Global, Module } from '@nestjs/common';

import {
  AI_METRICS,
  AI_OBJECT_STORE,
  AI_SYSTEM_PRISMA,
  type AiSystemPrisma,
} from '@marinoscar/platform-api/ai';
import { forSystem } from '@marinoscar/platform-api/core';
import { AppMetricsService } from '@marinoscar/platform-api/host';

import { PrismaService } from '../../prisma/prisma.service';
import { StorageProvidersModule } from '../../storage/providers/storage-providers.module';
import { AiObjectStoreAdapter } from './ai-object-store.adapter';

// =============================================================================
// The AI slice's host ports (RETRO-E1, #595)
// =============================================================================
//
//   AI_SYSTEM_PRISMA  -> `forSystem(PrismaService, reason)`   (the bypass client behind the two
//                        retention purges, the deployment-wide usage report and the catalogue
//                        sync's organization-less usage row; reasons `retention` and
//                        `admin-aggregate`, both platform built-ins)
//   AI_OBJECT_STORE   -> AiObjectStoreAdapter                 (MemoriaHub's own storage providers)
//   AI_METRICS        -> AppMetricsService                    (the host core's `app.ai.*` instruments)
//
// AI_SYSTEM_PRISMA: MemoriaHub has no separate `PrismaSystemService` yet (it arrives with the
// storage slice, RETRO-D1), so the bypass rides the app's client through the platform's own
// `forSystem` extension: every operation runs in a transaction whose FIRST statement is
// `set_config('app.rls_bypass', 'on', true)` (transaction-local, the platform's RLS contract).
// PLATFORM-ADOPTION-SHIM(RETRO-D1): bind `PrismaSystemService.forSystem` once it exists.
//
// `AI_TARGET_RESOLVER` is not bound: the platform's default order applies until RETRO-E2
// registers MemoriaHub's features and decides how each picks its model.
//
// `@Global()` because every sub-module of the AI slice injects the ports.
// =============================================================================

@Global()
@Module({
  imports: [StorageProvidersModule],
  providers: [
    {
      provide: AI_SYSTEM_PRISMA,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService): AiSystemPrisma => ({
        asSystem: (reason) =>
          forSystem(prisma, reason) as unknown as ReturnType<AiSystemPrisma['asSystem']>,
      }),
    },
    { provide: AI_OBJECT_STORE, useClass: AiObjectStoreAdapter },
    { provide: AI_METRICS, useExisting: AppMetricsService },
  ],
  exports: [AI_SYSTEM_PRISMA, AI_OBJECT_STORE, AI_METRICS],
})
export class AiHostModule {}

import { Global, Module } from '@nestjs/common';

import {
  AI_METRICS,
  AI_OBJECT_STORE,
  AI_SYSTEM_PRISMA,
  type AiSystemPrisma,
} from '@marinoscar/platform-api/ai';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { StorageProvidersModule } from '@marinoscar/platform-api/storage';

import { PrismaSystemService } from '../../prisma/prisma-system.service';
import { AiObjectStoreAdapter } from './ai-object-store.adapter';

// =============================================================================
// The AI slice's host ports (RETRO-E1, #595)
// =============================================================================
//
//   AI_SYSTEM_PRISMA  -> `PrismaSystemService.asSystem(reason)` (the bypass client behind the two
//                        retention purges, the deployment-wide usage report and the catalogue
//                        sync's organization-less usage row; reasons `retention` and
//                        `admin-aggregate`, both platform built-ins)
//   AI_OBJECT_STORE   -> AiObjectStoreAdapter                 (the storage slice's STORAGE_PROVIDER)
//   AI_METRICS        -> AppMetricsService                    (the host core's `app.ai.*` instruments)
//
// AI_SYSTEM_PRISMA: the system client's separate pool (RETRO-D1): every operation runs in a
// transaction whose FIRST statement is `set_config('app.rls_bypass', 'on', true)`.
//
// `AI_TARGET_RESOLVER` is not bound: the platform's default order applies until RETRO-E2
// registers MemoriaHub's features and decides how each picks its model.
//
// `@Global()` because every sub-module of the AI slice injects the ports.
// =============================================================================

@Global()
@Module({
  // The platform storage slice's static provider module (`StorageProviderRouter`).
  imports: [StorageProvidersModule],
  providers: [
    {
      provide: AI_SYSTEM_PRISMA,
      inject: [PrismaSystemService],
      useFactory: (prisma: PrismaSystemService): AiSystemPrisma => ({
        asSystem: (reason) => prisma.asSystem(reason) as unknown as ReturnType<AiSystemPrisma['asSystem']>,
      }),
    },
    { provide: AI_OBJECT_STORE, useClass: AiObjectStoreAdapter },
    { provide: AI_METRICS, useExisting: AppMetricsService },
  ],
  exports: [AI_SYSTEM_PRISMA, AI_OBJECT_STORE, AI_METRICS],
})
export class AiHostModule {}

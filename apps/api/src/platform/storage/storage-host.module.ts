// =============================================================================
// The storage slice's host ports (RETRO-D1, #563)
// =============================================================================
//
//   STORAGE_SYSTEM_DATA -> PrismaSystemService.asSystem(reason)
//
// The bypass client behind the slice's reviewed cross-organization paths: the
// stale-upload sweep, the stranded-object count of the provider-switch gate,
// the copy-only migration planner and the public avatar route. It is the
// SEPARATE system pool (every transaction sets `app.rls_bypass`
// transaction-locally); this file is its only storage binding, and it is on
// the ALLOWLIST of test/tenancy/system-injection-boundary.spec.ts.
//
// `@Global()` so the slice's services resolve the port from whichever module
// instantiates them. `PLATFORM_PRISMA` is bound by `platform-host.module.ts`.
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { STORAGE_SYSTEM_DATA, type StorageSystemData } from '@marinoscar/platform-api/storage';

import { PrismaSystemService } from '../../prisma/prisma-system.service';

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_SYSTEM_DATA,
      inject: [PrismaSystemService],
      useFactory: (system: PrismaSystemService): StorageSystemData => ({
        asSystem: (reason) => system.asSystem(reason) as unknown as ReturnType<StorageSystemData['asSystem']>,
      }),
    },
  ],
  exports: [STORAGE_SYSTEM_DATA],
})
export class StorageHostModule {}

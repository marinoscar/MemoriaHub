// =============================================================================
// The exports slice's host ports (RETRO-H2, #596)
// =============================================================================
//
//   EXPORTS_SYSTEM_DATA -> `PrismaSystemService.asSystem(reason)` (the bypass client the sources
//                          read through, reason `export`, and the expiry deletes through,
//                          reason `purge`; both platform built-ins)
//   EXPORTS_NOTIFIER    -> ExportsNotifierAdapter               (platform `NotificationsService`)
//   STORAGE_PROVIDER    -> ExportsStorageAdapter                (the platform storage slice, per row)
//
// EXPORTS_SYSTEM_DATA: the system client's separate pool (RETRO-D1): every operation runs in a
// transaction whose FIRST statement is `set_config('app.rls_bypass', 'on', true)`. Every query
// the slice and MemoriaHub's sources send names its owner explicitly, so lifting row-level
// security widens nothing.
//
// STORAGE_PROVIDER: PLATFORM-ADOPTION-SHIM(RETRO-SEAM-EXPORTS-ROUTING), see
// `exports-storage.adapter.ts` (per-row routing for downloads and purges). It works because
// `ExportsModule.forRoot` puts this module FIRST in its imports, before its own
// `StorageProvidersModule`, and Nest takes a token from the first import exporting it.
// `test/exports/exports-host.binding.spec.ts` asserts the slice gets this adapter.
//
// NOT @Global: `ExportsModule.forRoot({ imports: [ExportsHostModule] })` is the only consumer,
// which keeps the bypass client and the storage override narrow.
// =============================================================================

import { Module } from '@nestjs/common';
import { EXPORTS_NOTIFIER, EXPORTS_SYSTEM_DATA, type ExportsSystemData } from '@marinoscar/platform-api/exports';
import { STORAGE_PROVIDER } from '@marinoscar/platform-api/storage';

import { MediaProcessingModule } from '../../media-processing/media-processing.module';
import { PrismaSystemService } from '../../prisma/prisma-system.service';
import { ExportsNotifierAdapter } from './exports-notifier.adapter';
import { ExportsStorageAdapter } from './exports-storage.adapter';

@Module({
  imports: [MediaProcessingModule],
  providers: [
    {
      provide: EXPORTS_SYSTEM_DATA,
      inject: [PrismaSystemService],
      useFactory: (system: PrismaSystemService): ExportsSystemData => ({
        asSystem: (reason) => system.asSystem(reason) as unknown as ReturnType<ExportsSystemData['asSystem']>,
      }),
    },
    { provide: EXPORTS_NOTIFIER, useClass: ExportsNotifierAdapter },
    ExportsStorageAdapter,
    { provide: STORAGE_PROVIDER, useExisting: ExportsStorageAdapter },
  ],
  exports: [EXPORTS_SYSTEM_DATA, EXPORTS_NOTIFIER, STORAGE_PROVIDER],
})
export class ExportsHostModule {}

// =============================================================================
// The sharing slice's host ports (RETRO-I1, #562; kvox #485 / EAB #728 pattern)
// =============================================================================
//
//   SHARING_DATA           -> sharing-data.adapter.ts      (`runInOrg` / `runAsSystem`)
//   SHARING_EVENT_BUS      -> EVENT_BUS                    (the host core's cross-replica bus)
//   SHARING_EVENT_EMITTER  -> EventEmitter2                (the app's in-process emitter)
//   SHARING_NOTIFIER       -> sharing-notifier.adapter.ts  (`NotificationsService`; an
//                                                           invitation also allowlists
//                                                           the invitee, RETRO-I5)
//   SHARING_TENANCY        -> `single`                     (one organization; circles are
//                                                           sharing groups INSIDE it, never tenants)
//   SHARING_JOBS           -> sharing-jobs.adapter.ts      (`sharing.grants.prune`)
//
// NOT @Global: `SharingModule.forRoot({ imports: [SharingHostModule] })` is the only
// consumer, and the four sharing tables are under forced row-level security, so the
// bypass path is kept as close to the slice as possible. `NotificationsService`,
// `SettingsResolver`, `JobHandlerRegistry` / `JobsService` and `EVENT_BUS` come from
// global modules; `PrismaModule` is imported for `PrismaService`.
// =============================================================================

import { Module } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EVENT_BUS } from '@marinoscar/platform-api/host';
import {
  SHARING_DATA,
  SHARING_EVENT_BUS,
  SHARING_EVENT_EMITTER,
  SHARING_JOBS,
  SHARING_NOTIFIER,
  SHARING_TENANCY,
} from '@marinoscar/platform-api/sharing';
import type { SharingTenancy } from '@marinoscar/platform-api/sharing';

import { PrismaModule } from '../../prisma/prisma.module';
import { SharingDataAdapter } from './sharing-data.adapter';
import { SharingJobsAdapter } from './sharing-jobs.adapter';
import { InviteAllowlistService } from './invite-allowlist.service';
import { SharingNotifierAdapter } from './sharing-notifier.adapter';

/** MemoriaHub runs one organization (`TENANCY_MODE=single`), permanently. */
export const SINGLE_TENANCY: SharingTenancy = Object.freeze({ mode: () => 'single' as const });

@Module({
  imports: [PrismaModule],
  providers: [
    { provide: SHARING_DATA, useClass: SharingDataAdapter },
    { provide: SHARING_EVENT_BUS, useExisting: EVENT_BUS },
    { provide: SHARING_EVENT_EMITTER, useExisting: EventEmitter2 },
    { provide: SHARING_NOTIFIER, useClass: SharingNotifierAdapter },
    { provide: SHARING_TENANCY, useValue: SINGLE_TENANCY },
    { provide: SHARING_JOBS, useClass: SharingJobsAdapter },
    InviteAllowlistService,
  ],
  exports: [SHARING_DATA, SHARING_EVENT_BUS, SHARING_EVENT_EMITTER, SHARING_NOTIFIER, SHARING_TENANCY, SHARING_JOBS],
})
export class SharingHostModule {}

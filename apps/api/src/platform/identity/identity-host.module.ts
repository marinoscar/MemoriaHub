import { Global, Module } from '@nestjs/common';
import { AppMetricsService, EVENT_BUS } from '@marinoscar/platform-api/host';
import {
  IDENTITY_EVENT_BUS,
  IDENTITY_JOBS,
  IDENTITY_METRICS,
  IDENTITY_NODE_CREDENTIALS,
  IDENTITY_NOTIFIER,
  IDENTITY_PROFILE_IMAGES,
  USER_DEFAULTS,
  type IdentityMetrics,
  type IdentityNodeCredentials,
} from '@marinoscar/platform-api/identity';

import { PrismaModule } from '../../prisma/prisma.module';
import { NodeCredentialService } from '@marinoscar/platform-api/nodes';
import { IdentityJobsAdapter } from './identity-jobs.adapter';
import { MemoriaHubIdentityNotifier } from './identity-notifier.adapter';
import { AppProfileImages, AppUserDefaults } from './identity-user.adapters';

// =============================================================================
// The identity slice's host ports, bound to MemoriaHub (RETRO-B2, issue #611)
// =============================================================================
//
// Passed to `IdentityModule.forRoot({ imports: [IdentityHostModule] })`.
// GLOBAL, because `JwtAuthGuard` is instantiated in every module whose
// controllers use `@Auth()` and needs `IDENTITY_NODE_CREDENTIALS` there.
//
// The database is not here: it is core's `PLATFORM_PRISMA`, bound once by
// `platformHostModule`. The event bus and the metrics come from the host core
// (RETRO-B1) and are reused as they are.
//
//   IDENTITY_NODE_CREDENTIALS -> the platform nodes slice's NodeCredentialService (`nod_`, from the
//       global `NodeCredentialModule`; RETRO-C2, #581).
//   IDENTITY_JOBS -> the platform queue (RETRO-C1): JobsService + JobHandlerRegistry, both from the
//       global JobsModule.
// =============================================================================

/** Compile-time proof that the app's services ARE the ports, unadapted. */
export type AppMetricsServiceIsIdentityMetrics = AppMetricsService extends IdentityMetrics ? true : never;
export type NodeCredentialServiceIsIdentityNodeCredentials = NodeCredentialService extends IdentityNodeCredentials
  ? true
  : never;
const _metricsFit: AppMetricsServiceIsIdentityMetrics = true;
const _nodesFit: NodeCredentialServiceIsIdentityNodeCredentials = true;
void _metricsFit;
void _nodesFit;

const PORTS = [
  { provide: IDENTITY_NOTIFIER, useClass: MemoriaHubIdentityNotifier },
  { provide: USER_DEFAULTS, useClass: AppUserDefaults },
  { provide: IDENTITY_PROFILE_IMAGES, useClass: AppProfileImages },
  { provide: IDENTITY_JOBS, useClass: IdentityJobsAdapter },
  { provide: IDENTITY_METRICS, useExisting: AppMetricsService },
  { provide: IDENTITY_NODE_CREDENTIALS, useExisting: NodeCredentialService },
  { provide: IDENTITY_EVENT_BUS, useExisting: EVENT_BUS },
];

@Global()
@Module({
  imports: [PrismaModule],
  providers: PORTS,
  exports: PORTS.map((port) => port.provide),
})
export class IdentityHostModule {}

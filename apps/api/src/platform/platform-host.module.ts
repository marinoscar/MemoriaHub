// =============================================================================
// The platform host module (RETRO-B1, #597)
// =============================================================================
//
// Binds the DI-time host ports every packaged slice reaches the app through:
//
//   AUDIT_SINK       -> `audit_events` (PrismaAuditSink)
//   PLATFORM_PRISMA  -> the existing PrismaService
//
// `SYSTEM_SETTINGS_STORE` is not bound: no adopted slice reads it yet (the
// settings slice arrives with RETRO-B3). `PlatformHostModule.forRoot` is GLOBAL,
// so the host core and the app resolve these without importing anything. The
// host CORE module (event bus, maintenance, the response envelope) is mounted
// separately, by `host-core.config.ts`.
// =============================================================================

import { PlatformHostModule } from '@marinoscar/platform-api/core';

import { PrismaService } from '../prisma/prisma.service';
import { PrismaAuditSink } from './audit-sink.adapter';

export const platformHostModule = PlatformHostModule.forRoot({
  audit: { useClass: PrismaAuditSink },
  prisma: { useExisting: PrismaService },
});

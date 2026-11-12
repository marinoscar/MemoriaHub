import { Module, type DynamicModule } from '@nestjs/common';
import { JwtAuthGuard } from '@marinoscar/platform-api/identity';
import { ObjectProcessingModule, StorageProvidersModule } from '@marinoscar/platform-api/storage';
import { MemoriahubPortsModule, type MemoriahubPortBindings } from '@marinoscar/memoriahub-api/core';
import type { MemoriahubPrismaClientLike } from '@marinoscar/memoriahub-api/ports';

import { PrismaService } from '../prisma/prisma.service';
import { aiModule } from '../platform/ai/ai.config';
import { CredentialsModule } from '../platform/credentials/credentials.config';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { sharingModule } from '../platform/sharing/sharing.config';
import { StorageProviderResolver } from '../platform/storage/storage-provider.resolver';
import { webhooksModule } from '../platform/webhooks/webhooks.config';
import { PlatformMemoriahubAccessAdapter } from './access/platform-memoriahub-access.adapter';
import { PlatformMemoriahubAiAdapter } from './ai/platform-memoriahub-ai.adapter';
import { PlatformMemoriahubAuditAdapter } from './audit/platform-memoriahub-audit.adapter';
import { PlatformMemoriahubDoctorAdapter } from './doctor/platform-memoriahub-doctor.adapter';
import { PlatformMemoriahubEventsAdapter } from './events/platform-memoriahub-events.adapter';
import { PlatformMemoriahubIdentityAdapter } from './identity/platform-memoriahub-identity.adapter';
import { PlatformMemoriahubJobsAdapter } from './jobs/platform-memoriahub-jobs.adapter';
import { PlatformMemoriahubMetricsAdapter } from './metrics/platform-memoriahub-metrics.adapter';
import { PlatformMemoriahubNotifyAdapter } from './notify/platform-memoriahub-notify.adapter';
import { PlatformMemoriahubObjectStoreAdapter } from './object-store/platform-memoriahub-object-store.adapter';
import { PlatformMemoriahubSecretsAdapter } from './secrets/platform-memoriahub-secrets.adapter';
import { PlatformMemoriahubSettingsAdapter } from './settings/platform-memoriahub-settings.adapter';
import { PlatformMemoriahubSharingAdapter } from './sharing/platform-memoriahub-sharing.adapter';
import { PlatformMemoriahubWebhooksAdapter } from './webhooks/platform-memoriahub-webhooks.adapter';

// =============================================================================
// PlatformMemoriahubModule (RETRO-J4, #610; epic #558)
// =============================================================================
//
// The web app's binding of the host ports in `@marinoscar/memoriahub-api/ports`: one adapter per port over a
// platform slice. A packaged domain slice (J5 to J10) injects `MEMORIAHUB_PRISMA`, `MEMORIAHUB_JOBS`,
// `MEMORIAHUB_AI`, `MEMORIAHUB_OBJECT_STORE`, `MEMORIAHUB_ACCESS`, `MEMORIAHUB_IDENTITY`, `MEMORIAHUB_NOTIFY`,
// `MEMORIAHUB_SETTINGS`, `MEMORIAHUB_SECRETS`, `MEMORIAHUB_EVENTS`, `MEMORIAHUB_AUDIT`, `MEMORIAHUB_WEBHOOKS`
// and `MEMORIAHUB_METRICS` and imports nothing of the platform. This folder is the ONLY place in the domain's
// dependency graph that names `@marinoscar/platform-*` for these ports; a bare host binds its own.
//
//   MEMORIAHUB_PRISMA        -> (existing) the app's `PrismaService`, which already offers `runInOrg`
//   MEMORIAHUB_JOBS          -> jobs/          `JobsService`, `JobHandlerRegistry`, `ProviderThrottleService`, `JobScope`
//   MEMORIAHUB_AI            -> ai/            `AiService.forUser|forSystem`
//   MEMORIAHUB_OBJECT_STORE  -> object-store/  `StorageProviderResolver` (the active driver and the router), `ObjectProcessorRegistry`
//   MEMORIAHUB_ACCESS        -> access/        `OwnerAccessService`, `RecordAccessService`, `OwnerScopeSweepService`
//   MEMORIAHUB_IDENTITY      -> identity/      `JwtAuthGuard`, normalised here
//   MEMORIAHUB_NOTIFY        -> notify/        `NotificationsService`, `registerNotification`, the email template registry
//   MEMORIAHUB_SETTINGS      -> settings/      `AppSystemSettingsService`, `AppUserSettingsService`, `UserTimeZoneService`
//   MEMORIAHUB_SECRETS       -> secrets/       the platform encrypted `CredentialsService`
//   MEMORIAHUB_EVENTS        -> events/        the host core's `EVENT_BUS`
//   MEMORIAHUB_AUDIT         -> audit/         the platform `AUDIT_SINK`
//   MEMORIAHUB_WEBHOOKS      -> webhooks/      `WebhooksService.emit`
//   MEMORIAHUB_METRICS       -> metrics/       `AppMetricsService`
//   MEMORIAHUB_DOCTOR        -> doctor/        the platform `DoctorCheckRegistry`
//   MEMORIAHUB_SHARING       -> sharing/       `LinkGrantsService` (the expiring public links)
//
// GLOBAL, because `MemoriahubPortsModule` is: a domain module imports nothing to inject a port. Imported in
// `app.module.ts` after the platform slices and before any domain slice moved onto the ports. A missing binding
// is a boot error naming the port (`MemoriahubPortsModule.forRoot`).
//
// NOTHING CALLS A PORT YET. The existing app code keeps calling the platform until its slice moves (J5 to J10),
// so mounting this module changes no behaviour, no route and no job type.
// =============================================================================

/**
 * Providers the adapters need that no module exports on its own: the platform `JwtAuthGuard` (a guard class
 * Nest normally builds where it is used), the storage resolver and the modules whose providers the adapters
 * inject.
 */
@Module({
  imports: [aiModule, CredentialsModule, StorageProvidersModule, ObjectProcessingModule, OwnerAccessModule, webhooksModule, sharingModule],
  providers: [JwtAuthGuard, StorageProviderResolver],
  exports: [aiModule, CredentialsModule, JwtAuthGuard, StorageProviderResolver, StorageProvidersModule, ObjectProcessingModule, OwnerAccessModule, webhooksModule, sharingModule],
})
export class PlatformMemoriahubDepsModule {}

/**
 * Compile-time proof that `PrismaService` IS a `MemoriahubPrismaClientLike` (raw queries, both transaction
 * forms and `runInOrg`): `MEMORIAHUB_PRISMA` is bound by `useExisting`, so no adapter class exists to fail the
 * build if the client's shape drifts from the port.
 */
export const prismaServiceIsThePrismaPort = (prisma: PrismaService): MemoriahubPrismaClientLike => prisma;

/** The binding of every port to its web-app adapter. */
export const platformMemoriahubPorts: MemoriahubPortBindings = {
  prisma: { useExisting: PrismaService },
  jobs: { useClass: PlatformMemoriahubJobsAdapter },
  ai: { useClass: PlatformMemoriahubAiAdapter },
  objectStore: { useClass: PlatformMemoriahubObjectStoreAdapter },
  access: { useClass: PlatformMemoriahubAccessAdapter },
  identity: { useClass: PlatformMemoriahubIdentityAdapter },
  notify: { useClass: PlatformMemoriahubNotifyAdapter },
  settings: { useClass: PlatformMemoriahubSettingsAdapter },
  secrets: { useClass: PlatformMemoriahubSecretsAdapter },
  events: { useClass: PlatformMemoriahubEventsAdapter },
  audit: { useClass: PlatformMemoriahubAuditAdapter },
  webhooks: { useClass: PlatformMemoriahubWebhooksAdapter },
  metrics: { useClass: PlatformMemoriahubMetricsAdapter },
  doctor: { useClass: PlatformMemoriahubDoctorAdapter },
  sharing: { useClass: PlatformMemoriahubSharingAdapter },
  imports: [PlatformMemoriahubDepsModule],
};

/**
 * Builds the global ports module over the web-app adapters.
 *
 * @param ports - bindings to replace or remove (tests use it to prove a missing binding stops the boot).
 */
export function createPlatformMemoriahubModule(ports: Partial<MemoriahubPortBindings> = {}): DynamicModule {
  return MemoriahubPortsModule.forRoot({ ports: { ...platformMemoriahubPorts, ...ports } });
}

/** The module `app.module.ts` imports. */
export const PlatformMemoriahubModule: DynamicModule = createPlatformMemoriahubModule();

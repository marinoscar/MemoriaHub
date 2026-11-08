import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';

import { PrismaModule } from './prisma/prisma.module';
import './settings/registry';
import { FeaturesModule } from './settings/features.module';
import { MediaProcessingModule } from './media-processing/media-processing.module';
import { MediaModule } from './media/media.module';
import { CirclesModule } from './circles/circles.module';
import { AiModule } from './ai/ai.module';
import { aiModule } from './platform/ai/ai.config';
import { FaceModule } from './face/face.module';
import { EnrichmentModule } from './enrichment/enrichment.module';
import { SearchModule } from './search/search.module';
import { TaggingModule } from './tagging/tagging.module';
import { InsightsModule } from './insights/insights.module';
import { BurstModule } from './burst/burst.module';
import { DedupModule } from './dedup/dedup.module';
import { LocationGroupsModule } from './location-groups/location-groups.module';
import { LocationGroupsAdminModule } from './location-groups/location-groups-admin.module';
import { LocationInferenceModule } from './location-inference/location-inference.module';
import { ReviewRunsModule } from './review-runs/review-runs.module';
import { MetadataModule } from './metadata/metadata.module';
import { GeoModule } from './geo/geo.module';
import { emailModule } from './platform/email/email.config';
import { ShareModule } from './share/share.module';
import { SocialMediaModule } from './social-media/social-media.module';
import { EnhancementModule } from './enhancement/enhancement.module';
import { NodesModule } from './nodes/nodes.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { BroadcastsModule, notificationsModule } from './platform/notifications/notifications.config';
import { NotificationReconcileModule } from './notification-producers/notification-reconcile.module';
import { MemoriesModule } from './memories/memories.module';
import { MediaSyncModule } from './media-sync/media-sync.module';
import { AndroidAppModule } from './android-app/android-app.module';
import { doctorModule } from './doctor/doctor.config';
import { DoctorChecksModule } from './doctor/doctor-checks.module';
import { LoggerModule } from './common/logger/logger.module';

import { platformHostModule } from './platform/platform-host.module';
import { identityModule } from './platform/identity/identity.config';
import { ProfileModule } from './profile/profile.module';
// The jobs slice registers the `jobs` and `retention` namespaces; it must be composed before the settings.
import { jobsModule } from './platform/jobs/jobs.config';
import { settingsModule } from './platform/settings/settings.config';
import { credentialsModules } from './platform/credentials/credentials.config';
import { hostCoreModule } from './platform/host-core.config';
import { aboutModule } from './platform/about/about.config';
import { dbBackupModule } from './platform/db-backup/db-backup.config';
import { StorageConfigModule, storageModule } from './platform/storage/storage.config';
import { LocalStorageDownloadModule } from './platform-extensions/storage/local-storage-download.module';
import { telemetryModule } from './platform/telemetry/telemetry.config';
import { alertsModules } from './platform/alerts/alerts.config';
import { userDataModule } from './platform/user-data/user-data.config';
import { onboardingModule } from './platform/onboarding/onboarding.config';
import { MemoriaHubWebhooksModule } from './platform/webhooks/webhooks.config';
import { sharingModule } from './platform/sharing/sharing.config';

import configuration from './config/configuration';
import { AppSystemSettingsService } from './platform/settings/app-system-settings.service';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // Scheduling (must be at root level for NestJS 11)
    ScheduleModule.forRoot(),

    // Event emitter for async events
    // `job.settled` has eleven listeners once the storage (RETRO-D1), notifications, alerts and
    // webhooks slices are all mounted beside MemoriaHub's bridges. Past eventemitter2's default
    // of 10 it emits a leak warning whose object Node's `emitWarning` rejects, failing the boot.
    EventEmitterModule.forRoot({ maxListeners: 25 }),

    // Database
    PrismaModule,

    // The platform's DI-time host ports (audit sink, Prisma). Global.
    platformHostModule,

    // Logger
    LoggerModule,

    // Identity (RETRO-B2, #611): sign-in, sessions, users, allowlist, PATs, the
    // device flow and RBAC, from @marinoscar/platform-api/identity, in
    // single-organization mode. Provides the `@Auth` guards every module's
    // controllers use. `POST /api/auth/test/login` is mounted by it outside
    // production only (`enableTestAuth`).
    identityModule,
    // The app-owned half of the user: profile picture and person link.
    ProfileModule,

    // Feature modules
    // Settings (RETRO-B3, #614): `/api/system-settings`, `/api/user-settings` and `/api/org-settings`
    // from @marinoscar/platform-api/settings, with every MemoriaHub namespace registered in
    // `settings/registry`. Global: provides AppSystemSettingsService and UserSettingsService.
    // Before the host core on purpose: the host reads the `maintenance` namespace through it.
    settingsModule,
    // Jobs (RETRO-C1, #575): the background queue, the in-process worker pool, the reaper and
    // `/api/admin/jobs/*` from @marinoscar/platform-api/jobs. Global. The 38 handlers are still the
    // app's, behind the legacy adapter (EnrichmentModule).
    jobsModule,
    // Credentials (RETRO-B4, #617): the encrypted (purpose, name) store; purposes in
    // platform/credentials/credential-purposes.manifest.ts.
    ...credentialsModules,
    FeaturesModule,
    // The platform host core (RETRO-B1, #597): the event bus, the app metrics,
    // maintenance mode (and its ONLY global guard, `MaintenanceGuard`),
    // `/api/health/*`, the `{ data }` envelope, the request log line, the
    // exception filter and request ids. Replaces the old HealthModule,
    // MaintenanceModule and this file's own APP_FILTER / APP_INTERCEPTOR /
    // APP_GUARD providers and request-id middleware. Placed here because the
    // generated OpenAPI document lists paths in module order.
    hostCoreModule,
    // `GET /api/admin/about` (`system_settings:read`).
    aboutModule,
    // Object storage (RETRO-D1, #563): @marinoscar/platform-api/storage. `/api/storage/objects`, the
    // `storage.object.process` and stale-upload jobs, `/api/admin/storage-config` and the copy-only
    // provider migration (`/api/admin/storage/migrations`); the `local` driver is MemoriaHub's
    // (app-registrations/storage.ts), and so are the seven post-upload processors (MediaProcessingModule).
    storageModule,
    StorageConfigModule,
    LocalStorageDownloadModule,
    MediaProcessingModule,
    MediaModule,
    CirclesModule,
    AiModule,
    // The platform AI slice (RETRO-E1, #595). `AiModule` above is MemoriaHub's legacy AI settings
    // module (the old /api/ai/* admin routes and the provider registry), kept until RETRO-E2/E4.
    aiModule,
    FaceModule,
    EnrichmentModule,
    SearchModule,
    TaggingModule,
    InsightsModule,
    // The platform Doctor (RETRO-B1b, #602): `GET /api/admin/doctor` and the
    // support bundle. Global; provides the check registry.
    doctorModule,
    DoctorChecksModule,
    BurstModule,
    DedupModule,
    LocationGroupsModule,
    LocationGroupsAdminModule,
    LocationInferenceModule,
    ReviewRunsModule,
    MetadataModule,
    GeoModule,
    // The platform email slice (RETRO-D2): transports, the `email` settings row and
    // `/api/email-settings`, the template registry (with this app's three templates,
    // registered by `app-registrations/email.ts`) and the Doctor check `email.config`.
    // Sends go through the notifications slice's email channel (RETRO-D3).
    emailModule,
    ShareModule,
    SocialMediaModule,
    EnhancementModule,
    NodesModule,
    WorkflowsModule,
    // The platform notifications slice (RETRO-D3, #576): the inbox, the SSE
    // stream, Web Push, the policy and preferences, broadcasts and the delivery
    // log. MemoriaHub's events are `platform/notifications/notification.manifest.ts`;
    // its producers are `notification-producers/`.
    notificationsModule,
    BroadcastsModule,
    NotificationReconcileModule,
    MemoriesModule,
    // Database backup and restore (RETRO-D4, #580): @marinoscar/platform-api/db-backup, with
    // MemoriaHub's restore gate, carry-over and legacy prefix (app-registrations/db-backup.ts).
    dbBackupModule,
    MediaSyncModule,
    AndroidAppModule,
    // Telemetry (RETRO-T2, #625): @marinoscar/platform-api/telemetry. The settings page, the
    // explorer and the dashboard at /admin/settings/telemetry, the runtime export gate over
    // RETRO-T1's SDK, the retention job and the `telemetry.*` Doctor checks.
    telemetryModule,
    // Alerts (RETRO-H5, #609): @marinoscar/platform-api/alerts. Rules over telemetry
    // metrics, worker-node events and fleet health, incidents and their notifications
    // (`/api/admin/alerts`, `alerts:read|write`), plus MemoriaHub's default rules
    // and its two kinds. Binding: `platform/alerts/alerts.config.ts`.
    ...alertsModules,
    // User data (RETRO-H1, #591): @marinoscar/platform-api/user-data. The Danger Zone
    // (`/api/user-data/*`), the admin factory reset and offboarding, with MemoriaHub's
    // keep-or-delete decisions, delegated purges and reset steps (platform/user-data/).
    userDataModule,
    // First-run onboarding (RETRO-H3, #599): @marinoscar/platform-api/onboarding. `GET /api/onboarding`
    // (the Get started and Setup guide checklists, derived on every read) and
    // `GET /api/admin/onboarding/metrics`, over the platform's steps plus MemoriaHub's media steps
    // (`platform/onboarding/`). Last among the feature modules: it reads the Doctor and the settings,
    // owns no table, and stores only the user's intent in the `onboarding` user-settings namespace.
    onboardingModule,
    // Webhooks (RETRO-H4, #603): @marinoscar/platform-api/webhooks (endpoints under
    // /api/webhooks, /api/org/webhooks and /api/admin/webhooks, signed deliveries as queue
    // jobs, the SSRF egress guard, the `webhook` notification channel), plus MemoriaHub's
    // events and the global `MemoriaHubWebhooks` its write paths raise them through.
    MemoriaHubWebhooksModule,
    // Sharing (RETRO-I1, #562): @marinoscar/platform-api/sharing, single-organization mode.
    // `/api/groups`, `/api/grants`, `/api/grants/links` and the public `/api/public/links/current`
    // are live and empty: circles and public shares keep deciding access until RETRO-I2..I5
    // (mapping: docs/platform-adoption/circles-to-groups.md). Binding: `platform/sharing/`.
    sharingModule,
  ],
  providers: [
    // Global validation pipe (Zod)
    //
    // NOTE (issue #289) — the bodyless-POST rule for body DTOs:
    // Fastify leaves `request.body` as `undefined` when a request carries no
    // body at all (e.g. `fetch(url, { method: 'POST' })`, no Content-Type, no
    // payload). Nest's `@Body()` hands that `undefined` straight to this pipe,
    // and `z.object({...}).parse(undefined)` throws `invalid_type` no matter
    // how optional every one of its fields is — so an endpoint documenting an
    // empty body as "use the defaults" would still 400.
    //
    // The fix is per-DTO: any body schema whose fields are ALL optional carries
    // a top-level `.default({})`, which maps that `undefined` to `{}` before
    // the object schema ever sees it. It must come LAST in the chain (after any
    // `.strict()` / `.refine()`), and it also surfaces as `default: {}` in the
    // generated OpenAPI schema.
    //
    // Caveat 1: `.default({})` does not re-parse the default — it short-circuits
    // and returns that `{}` as-is. When a field carries its own inner default
    // (e.g. `force: z.boolean().optional().default(false)`), that inner default
    // would therefore NOT be applied to a bodyless request, and `{}` would not
    // even satisfy the schema's own output type. Those schemas use `.prefault({})`
    // instead, which feeds `{}` through the parse so a bodyless request is exactly
    // equivalent to `{}`; see metadata/admin-metadata.controller.ts.
    //
    // Caveat 2: `.default({})` BYPASSES a top-level `.refine()` for the default
    // value — Zod short-circuits and hands back that `{}` without running the
    // refine at all. So it must NOT be added to a schema whose top-level refine
    // is precisely what makes an empty body invalid (e.g. "at least one of these
    // optional fields is required"): the schema would still pattern-match the
    // #289 fix — every field optional — while silently ACCEPTING the bodyless
    // request it is supposed to reject. Such a schema is a deliberate exclusion
    // from the rule above and must keep throwing on `parse(undefined)`. (The
    // repo's only worked example of this, the v0 backup trigger DTO, was
    // removed when that feature was retired; the rule still holds for any
    // future refine-guarded all-optional body schema.)
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
    // The exception filter, the logging and envelope interceptors and
    // `MaintenanceGuard` (the application's ONLY global guard, and the first)
    // are the platform host core's (`hostCoreModule` above). If another global
    // guard is ever added, list it with a reason under `allowedAppGuards` of the
    // `host` conformance suite (`test/conformance.spec.ts`).
  ],
})
export class AppModule {}

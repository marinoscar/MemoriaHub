import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';

import { PrismaModule } from './prisma/prisma.module';
import './settings/registry';
import { FeaturesModule } from './settings/features.module';
import { StorageModule } from './storage/storage.module';
import { MediaModule } from './media/media.module';
import { CirclesModule } from './circles/circles.module';
import { AiModule } from './ai/ai.module';
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
import { EmailModule } from './email/email.module';
import { StorageSettingsModule } from './storage-settings/storage-settings.module';
import { ShareModule } from './share/share.module';
import { SocialMediaModule } from './social-media/social-media.module';
import { EnhancementModule } from './enhancement/enhancement.module';
import { NodesModule } from './nodes/nodes.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { NotificationsModule } from './notifications/notifications.module';
import { NotificationsReconcileModule } from './notifications/notifications-reconcile.module';
import { BroadcastsModule } from './notifications/broadcasts/broadcasts.module';
import { MemoriesModule } from './memories/memories.module';
import { DbBackupModule } from './db-backup/db-backup.module';
import { MediaSyncModule } from './media-sync/media-sync.module';
import { AndroidAppModule } from './android-app/android-app.module';
import { doctorModule } from './doctor/doctor.config';
import { DoctorChecksModule } from './doctor/doctor-checks.module';
import { LoggerModule } from './common/logger/logger.module';

import { platformHostModule } from './platform/platform-host.module';
import { identityModule } from './platform/identity/identity.config';
import { ProfileModule } from './profile/profile.module';
import { settingsModule } from './platform/settings/settings.config';
import { credentialsModules } from './platform/credentials/credentials.config';
import { hostCoreModule } from './platform/host-core.config';
import { aboutModule } from './platform/about/about.config';

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
    EventEmitterModule.forRoot(),

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
    StorageModule,
    MediaModule,
    CirclesModule,
    AiModule,
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
    EmailModule,
    StorageSettingsModule,
    ShareModule,
    SocialMediaModule,
    EnhancementModule,
    NodesModule,
    WorkflowsModule,
    NotificationsModule,
    NotificationsReconcileModule,
    BroadcastsModule,
    MemoriesModule,
    DbBackupModule,
    MediaSyncModule,
    AndroidAppModule,
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

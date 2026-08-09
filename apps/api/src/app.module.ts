import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';

import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { SettingsModule } from './settings/settings.module';
import { HealthModule } from './health/health.module';
import { AllowlistModule } from './allowlist/allowlist.module';
import { DeviceAuthModule } from './device-auth/device-auth.module';
import { StorageModule } from './storage/storage.module';
import { PatModule } from './pat/pat.module';
import { MediaModule } from './media/media.module';
import { CirclesModule } from './circles/circles.module';
import { BackupModule } from './jobs/backup/backup.module';
import { AiModule } from './ai/ai.module';
import { FaceModule } from './face/face.module';
import { EnrichmentModule } from './enrichment/enrichment.module';
import { SearchModule } from './search/search.module';
import { TaggingModule } from './tagging/tagging.module';
import { InsightsModule } from './insights/insights.module';
import { BurstModule } from './burst/burst.module';
import { DedupModule } from './dedup/dedup.module';
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
import { MemoriesModule } from './memories/memories.module';
import { DoctorModule } from './doctor/doctor.module';
import { LoggerModule } from './common/logger/logger.module';
import { TestAuthModule } from './test-auth/test-auth.module';

import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';

import configuration from './config/configuration';

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

    // Logger
    LoggerModule,

    // Feature modules
    CommonModule,
    AuthModule,
    UsersModule,
    SettingsModule,
    HealthModule,
    AllowlistModule,
    DeviceAuthModule,
    StorageModule,
    PatModule,
    MediaModule,
    CirclesModule,
    BackupModule,
    AiModule,
    FaceModule,
    EnrichmentModule,
    SearchModule,
    TaggingModule,
    InsightsModule,
    DoctorModule,
    BurstModule,
    DedupModule,
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
    MemoriesModule,

    // Test modules (non-production only)
    ...(process.env.NODE_ENV !== 'production' ? [TestAuthModule] : []),
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
    // value — the refine never runs for a bodyless request. So it must not be
    // added to a schema whose refine is what makes an empty body invalid; see
    // jobs/backup/dto/trigger-backup.dto.ts for the one deliberate exclusion.
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    // Global logging interceptor
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    // Global response transform interceptor
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware)
      .forRoutes('*');
  }
}

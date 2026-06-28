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
import { MetadataModule } from './metadata/metadata.module';
import { GeoModule } from './geo/geo.module';
import { StorageSettingsModule } from './storage-settings/storage-settings.module';
import { ShareModule } from './share/share.module';
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
    BurstModule,
    MetadataModule,
    GeoModule,
    StorageSettingsModule,
    ShareModule,

    // Test modules (non-production only)
    ...(process.env.NODE_ENV !== 'production' ? [TestAuthModule] : []),
  ],
  providers: [
    // Global validation pipe (Zod)
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

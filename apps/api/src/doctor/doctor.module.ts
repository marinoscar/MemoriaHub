import { Module } from '@nestjs/common';
import { DoctorController } from './doctor.controller';
import { DoctorService } from './doctor.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { AiModule } from '../ai/ai.module';
import { FaceModule } from '../face/face.module';
import { GeoModule } from '../geo/geo.module';
import { StorageSettingsModule } from '../storage-settings/storage-settings.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { SocialMediaModule } from '../social-media/social-media.module';
import { DedupModule } from '../dedup/dedup.module';
// Android checks (#507): AndroidAppService + AndroidReleaseService, read-only.
// AndroidAppModule imports only StorageProvidersModule (→ SettingsModule), and
// nothing imports DoctorModule except AppModule, so this closes no cycle.
// Media Sync devices are read through the global PrismaModule; MediaSyncModule
// (and its CirclesModule import) is deliberately NOT pulled in.
import { AndroidAppModule } from '../android-app/android-app.module';

@Module({
  imports: [
    PrismaModule,
    SettingsModule,
    AiModule,
    FaceModule,
    GeoModule,
    StorageSettingsModule,
    EnrichmentModule,
    SocialMediaModule,
    DedupModule,
    AndroidAppModule,
  ],
  controllers: [DoctorController],
  providers: [DoctorService],
})
export class DoctorModule {}

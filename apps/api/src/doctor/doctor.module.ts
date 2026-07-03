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

@Module({
  imports: [
    PrismaModule,
    SettingsModule,
    AiModule,
    FaceModule,
    GeoModule,
    StorageSettingsModule,
    EnrichmentModule,
  ],
  controllers: [DoctorController],
  providers: [DoctorService],
})
export class DoctorModule {}

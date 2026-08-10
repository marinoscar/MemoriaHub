import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { MaintenanceModule } from '../common/maintenance/maintenance.module';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.indicator';

@Module({
  // MaintenanceModule: /health/ready reports not-ready while maintenance is
  // active (issue #348).
  imports: [TerminusModule, MaintenanceModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator],
})
export class HealthModule {}

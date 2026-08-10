import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { SettingsModule } from '../../settings/settings.module';
import { PatModule } from '../../pat/pat.module';
import { NodesModule } from '../../nodes/nodes.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceModeService } from './maintenance-mode.service';

/**
 * Admin-controlled maintenance mode (issue #348).
 *
 * MaintenanceGuard is registered as a global APP_GUARD in app.module.ts (NOT
 * here) so it applies to every route in the application, including routes in
 * modules this one knows nothing about.
 *
 * JwtModule is registered locally with the same factory AuthModule uses,
 * rather than importing AuthModule, for two reasons: the guard only ever needs
 * to VERIFY a token (never sign one), and importing AuthModule would drag its
 * whole dependency tree (Passport, allowlist, PAT, email) into a module the
 * global guard depends on.
 *
 * PatModule/NodesModule are imported because MaintenanceController is mounted
 * here and its `@Auth()` decorator applies JwtAuthGuard, which injects
 * PatService and NodeCredentialService.
 */
@Module({
  imports: [
    SettingsModule,
    PatModule,
    NodesModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret'),
      }),
    }),
  ],
  controllers: [MaintenanceController],
  providers: [MaintenanceModeService],
  exports: [MaintenanceModeService, JwtModule],
})
export class MaintenanceModule {}

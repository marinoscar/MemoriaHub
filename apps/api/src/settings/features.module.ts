import { Module } from '@nestjs/common';

import { FeaturesController } from './features.controller';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

/**
 * `GET /api/features`: the client-visible feature flags, for any authenticated user. The settings
 * themselves (`/api/system-settings`, `/api/user-settings`) are the platform settings slice
 * (`platform/settings/settings.config.ts`), which is global and provides `AppSystemSettingsService`.
 */
@Module({ controllers: [FeaturesController] })
export class FeaturesModule {}

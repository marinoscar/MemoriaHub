import { Injectable } from '@nestjs/common';
import type { OnboardingFeatureGate } from '@marinoscar/platform-api/onboarding';

import { AppSystemSettingsService } from '../settings/app-system-settings.service';
import { isMemoriesEnabled } from '../../settings/feature-gates';

// =============================================================================
// The onboarding slice's feature gate (RETRO-H3, #599)
// =============================================================================
//
// A step that names a `feature` is omitted while the feature is off: that is how a user step for a
// switched-off media feature is HIDDEN rather than shown as "todo" (`memoriahub.name_people` names
// `faceRecognition`). A feature is the `features.<name>` system flag, read from the cached settings
// document (5 s TTL, the same read every feature gate makes); `memories` also honours its
// `MEMORIES_ENABLED` kill switch. A name this app does not know is off.
// =============================================================================

@Injectable()
export class OnboardingFeaturesAdapter implements OnboardingFeatureGate {
  constructor(private readonly settings: AppSystemSettingsService) {}

  async isEnabled(feature: string): Promise<boolean> {
    const settings = await this.settings.getSettings();
    if (feature === 'memories') return isMemoriesEnabled(settings);
    return settings.features?.[feature] === true;
  }
}

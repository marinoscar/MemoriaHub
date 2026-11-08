import { Global, Module } from '@nestjs/common';
import { ONBOARDING_DATA, ONBOARDING_FEATURES } from '@marinoscar/platform-api/onboarding';

import { OnboardingDataAdapter } from './onboarding-data.adapter';
import { OnboardingFeaturesAdapter } from './onboarding-features.adapter';

// =============================================================================
// The onboarding slice's host ports (RETRO-H3, #599)
// =============================================================================
//
//   ONBOARDING_DATA      -> OnboardingDataAdapter      (Prisma; required)
//   ONBOARDING_FEATURES  -> OnboardingFeaturesAdapter  (the `features.*` system flags)
//
// `@Global()` so the slice's services resolve the ports from whichever module instantiates them.
// `AppSystemSettingsService` and `PrismaService` are global (settingsModule, PrismaModule).
// =============================================================================

@Global()
@Module({
  providers: [
    OnboardingDataAdapter,
    OnboardingFeaturesAdapter,
    { provide: ONBOARDING_DATA, useExisting: OnboardingDataAdapter },
    { provide: ONBOARDING_FEATURES, useExisting: OnboardingFeaturesAdapter },
  ],
  exports: [ONBOARDING_DATA, ONBOARDING_FEATURES],
})
export class OnboardingHostModule {}

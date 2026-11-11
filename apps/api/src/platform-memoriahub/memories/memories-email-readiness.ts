import { Injectable } from '@nestjs/common';
import { EmailSettingsService } from '@marinoscar/platform-api/email';
import type { MemoriesEmailReadiness } from '@marinoscar/memoriahub-api/memories';

// =============================================================================
// MemoriesEmailReadiness: can the deployment deliver the memories digest? (RETRO-J8, #619)
// =============================================================================
//
// The platform email settings (`email` row, RETRO-D2): enabled, a provider and a from address, which
// is exactly the precondition the platform email channel applies before it sends. Checking it up front
// is what makes "email not configured => the digest task no-ops and in-app memories are unaffected"
// true at the CRON level rather than only at the send. Never throws.
// =============================================================================

@Injectable()
export class PlatformMemoriesEmailReadiness implements MemoriesEmailReadiness {
  constructor(private readonly emailSettings: EmailSettingsService) {}

  isReady(): Promise<boolean> {
    return this.emailSettings.get().then(
      (settings) => Boolean(settings.enabled && settings.provider && settings.fromAddress),
      () => false,
    );
  }
}

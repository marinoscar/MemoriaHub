import { Injectable } from '@nestjs/common';
import type { IdentityProfileImages, UserDefaults } from '@marinoscar/platform-api/identity';

import { DEFAULT_USER_SETTINGS } from '../../common/types/settings.types';

// =============================================================================
// USER_DEFAULTS and IDENTITY_PROFILE_IMAGES -> the app's settings and avatar
// =============================================================================

/** A new user's `user_settings` value: MemoriaHub's `DEFAULT_USER_SETTINGS`. */
@Injectable()
export class AppUserDefaults implements UserDefaults {
  userSettings(): Record<string, unknown> {
    return structuredClone(DEFAULT_USER_SETTINGS) as unknown as Record<string, unknown>;
  }
}

/**
 * The picture shown for a user.
 *
 * MemoriaHub materialises the resolved avatar (an upload, a linked person, or
 * the provider picture) into the platform column `users.profile_image_url`; the
 * app's `UserAvatarService` is its only writer. The identity slice calls this
 * port with the loaded user row, so the materialised column is read here and the
 * provider picture is the fallback, exactly the rule `GET /api/auth/me` followed
 * before the move. The profile settings the port also receives
 * (`profile.imageSource`) are the platform's own avatar model, which MemoriaHub
 * does not use.
 */
@Injectable()
export class AppProfileImages implements IdentityProfileImages {
  resolveImageUrl(user: { id: string; providerProfileImageUrl: string | null }, _storedProfile: unknown): string | null {
    const materialised = (user as { profileImageUrl?: string | null }).profileImageUrl;
    return materialised || user.providerProfileImageUrl || null;
  }

  /** The upload lives in `user_profiles`, not in settings; the settings UI hint is not used. */
  hasUploadedImage(_storedProfile: unknown): boolean {
    return false;
  }
}

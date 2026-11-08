import { Injectable } from '@nestjs/common';
import type { NormalizedProfileSettings, SettingsProfileImages } from '@marinoscar/platform-api/settings';
import { normalizeProfileSettings } from '@marinoscar/platform-api/storage';

/**
 * The settings slice's `SETTINGS_PROFILE_IMAGES` port (RETRO-B3).
 *
 * `profile.imageSource` / `profile.imageObjectId` are the PLATFORM's picture model. MemoriaHub's
 * picture is its own (issue #354, kept by RETRO-B2): `UserAvatarService` renders it from the OAuth
 * picture, an upload or the linked person and keeps the state on `user_profiles`, and the storage
 * slice's `ProfileImageModule` is not mounted (RETRO-D1). So the platform fields stay at their
 * defaults here, and a PATCH that tries to point them at an uploaded object is refused:
 * `isUploadedAvatar` is always false. `normalize` is the storage slice's own rule
 * (`normalizeProfileSettings`), imported since RETRO-D1 made the `storage` settings namespace the
 * slice's (before, the import declared a conflicting namespace and the rule was copied here).
 */
@Injectable()
export class SettingsProfileImagesAdapter implements SettingsProfileImages {
  normalize(stored: unknown): NormalizedProfileSettings {
    return normalizeProfileSettings(stored);
  }

  async isUploadedAvatar(): Promise<boolean> {
    return false;
  }
}

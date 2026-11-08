import { Injectable } from '@nestjs/common';
import type { NormalizedProfileSettings, SettingsProfileImages } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

/**
 * The settings slice's `SETTINGS_PROFILE_IMAGES` port (RETRO-B3).
 *
 * `profile.imageSource` / `profile.imageObjectId` are the PLATFORM's picture model. MemoriaHub's
 * picture is its own (issue #354): `UserAvatarService` renders it from the OAuth picture, an
 * upload or the linked person and keeps the state on `user_profiles`. So the platform fields stay
 * at their defaults here, and a PATCH that tries to point them at an uploaded object is refused:
 * `isUploadedAvatar` is always false. `normalize` is the platform's own rule (a stored legacy
 * `useProviderImage: true` reads as `imageSource: 'provider'`, `false` as `'none'`), written out here
 * because the function lives in `@marinoscar/platform-api/storage`, whose import would declare the
 * storage slice's settings namespace beside this app's temporary `storage` one (type conflict) until
 * RETRO-D1.
 *
 * PLATFORM-ADOPTION-SHIM(RETRO-D1): the storage slice brings the platform's profile-image upload.
 */
const IMAGE_SOURCES = ['none', 'provider', 'upload'] as const;
type ImageSource = (typeof IMAGE_SOURCES)[number];

@Injectable()
export class SettingsProfileImagesAdapter implements SettingsProfileImages {
  normalize(stored: unknown): NormalizedProfileSettings {
    const profile = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
    const imageSource: ImageSource = IMAGE_SOURCES.includes(profile['imageSource'] as ImageSource)
      ? (profile['imageSource'] as ImageSource)
      : profile['useProviderImage'] === false
        ? 'none'
        : 'provider';

    const normalized: NormalizedProfileSettings = {
      imageSource,
      imageObjectId: z.string().uuid().safeParse(profile['imageObjectId']).success
        ? (profile['imageObjectId'] as string)
        : null,
    };
    if (typeof profile['displayName'] === 'string') normalized.displayName = profile['displayName'];
    return normalized;
  }

  async isUploadedAvatar(): Promise<boolean> {
    return false;
  }
}

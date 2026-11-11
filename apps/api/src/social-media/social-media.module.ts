import { Module } from '@nestjs/common';
import {
  AdminSocialMediaController,
  SOCIAL_MEDIA_POST_DETECTION,
  SocialMediaMediaController,
  SocialMediaModule as PackagedSocialMediaModule,
} from '@marinoscar/memoriahub-api/social-media';

import { FaceModule } from '../face/face.module';
import { MediaModule } from '../media/media.module';
import { videoJobTimeoutMs } from '../platform/jobs/legacy-env';
import { SocialMediaPostDetectionAdapter } from './post-detection.adapter';

const packagedSocialMedia = PackagedSocialMediaModule.forRoot({
  providers: [
    SocialMediaPostDetectionAdapter,
    { provide: SOCIAL_MEDIA_POST_DETECTION, useExisting: SocialMediaPostDetectionAdapter },
  ],
  // The face module provides the frame extractor of the Tier-2 OCR; the media module the post-detection fan-out.
  imports: [FaceModule, MediaModule],
  videoJobTimeoutMs: videoJobTimeoutMs(),
});

/**
 * The web app's binding of the social-media slice (RETRO-J10, #624). Social-media video detection (the Tier-1
 * rule engine, the Tier-2 OCR fallback), the `social_media_detection` job, the upload fan-out registration, the
 * backfill service and the OCR service live in `@marinoscar/memoriahub-api/social-media`; this module mounts the
 * two controllers and binds the post-detection fan-out to the media enrichment service.
 *
 * No circular import: FaceModule already imports MediaModule; nothing imports this module except AppModule and
 * the Doctor checks.
 */
@Module({
  imports: [packagedSocialMedia],
  controllers: [SocialMediaMediaController, AdminSocialMediaController],
  exports: [packagedSocialMedia],
})
export class SocialMediaModule {}

// PLATFORM-ADOPTION-SHIM(#562): retired by RETRO-I3/I4/I5. Public shares (`MediaShare`,
// /api/shares, /api/public/shares/:token) stay app-owned while the platform sharing slice
// is mounted beside them; RETRO-I4 imports them as link grants (importLegacyToken). Mapping:
// docs/platform-adoption/circles-to-groups.md.

import { Module } from '@nestjs/common';
import { CirclesModule } from '../circles/circles.module';
import { MediaModule } from '../media/media.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { ShareController } from './share.controller';
import { PublicShareController } from './public-share.controller';
import { ShareService } from './share.service';

/**
 * ShareModule
 *
 * Provides public media sharing via token-based share links.
 *
 * Imports CirclesModule so that CircleMembershipService is available for
 * access checks when creating shares.
 *
 * Imports MediaModule so that MediaThumbnailService is available for
 * signing thumbnail URLs in share list previews.
 *
 * Imports MediaProcessingModule so that StorageProviderResolver is available
 * for PublicShareController's byte-proxy endpoint.
 *
 * PrismaModule (@Global) and ConfigModule (global) are resolved automatically
 * without explicit imports.
 */
@Module({
  imports: [
    CirclesModule,
    MediaModule,
    MediaProcessingModule,
  ],
  controllers: [ShareController, PublicShareController],
  providers: [ShareService],
})
export class ShareModule {}

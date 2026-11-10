// =============================================================================
// Public links on the sharing slice (RETRO-I4, #578)
// =============================================================================
//
// Replaced `share/` (`MediaShare`, `/api/shares`, `/api/public/shares/:token`):
//
//   GET /api/public/links/media     a shared photo or video   (LinkGrantGuard)
//   GET /api/public/links/album     a shared album            (LinkGrantGuard)
//   GET /api/public/shares/*        410 LEGACY_SHARE_ROUTE    (retired)
//   GET /api/admin/links            every public link         (sharing:admin)
//
// Creating, listing, re-dating and revoking a link are the slice's own routes
// (`/api/grants/links`, `/api/grants/:id`); the `media_item` / `album` resource
// types (`app-registrations/sharing.ts`) grant links the `viewer` role and let a
// group editor (a circle collaborator) manage them (`share_link: 'editor'`).
// Mapping and operator procedure: docs/specs/public-sharing.md,
// docs/runbooks/circles-to-groups.md ("Public shares to link grants").
// =============================================================================

import { Module } from '@nestjs/common';

import { MediaModule } from '../media/media.module';
import { MediaProcessingModule } from '../media-processing/media-processing.module';
import { sharingModule } from '../platform/sharing/sharing.config';
import { AdminPublicLinksController } from './admin-public-links.controller';
import { AdminPublicLinksService } from './admin-public-links.service';
import { LegacyPublicShareController } from './legacy-public-share.controller';
import { PublicAlbumLinkController } from './public-album-link.controller';
import { PublicLinkViewService } from './public-link-view.service';
import { PublicMediaLinkController } from './public-media-link.controller';

@Module({
  imports: [sharingModule, MediaModule, MediaProcessingModule],
  controllers: [PublicMediaLinkController, PublicAlbumLinkController, LegacyPublicShareController, AdminPublicLinksController],
  providers: [PublicLinkViewService, AdminPublicLinksService],
})
export class PublicLinksModule {}

// =============================================================================
// GET /api/public/links/media: a shared photo or video, opened by its link (RETRO-I4, #578)
// =============================================================================
//
// The platform's public-route pattern (`@marinoscar/platform-api/sharing`):
//   @Public()                  deliberately public; the link authenticates
//   @UseGuards(LinkGrantGuard) resolves `X-Link-Token` (never a path or a query
//                              string), or answers the ONE 404 for every failure
//                              (429 past `links.maxMissesPerIp`), and sets
//                              `Cache-Control: no-store` / `Referrer-Policy: no-referrer`
//   @LinkGrantResource         only `media_item` links whose role reaches `read`
// Replaces `GET /api/public/shares/:token` for a media share; the bytes are a
// presigned URL now, never proxied (`PublicLinkViewService`).
// =============================================================================

import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@marinoscar/platform-api/identity';
import { CurrentLinkGrant, LinkGrantGuard, LinkGrantResource, type ResolvedLinkGrant } from '@marinoscar/platform-api/sharing';

import { PublicLinkViewService, type PublicMediaLinkView } from './public-link-view.service';

@ApiTags('Public Sharing')
@Controller('public/links')
@Public()
@UseGuards(LinkGrantGuard)
export class PublicMediaLinkController {
  constructor(private readonly views: PublicLinkViewService) {}

  @Get('media')
  @LinkGrantResource('media_item', { action: 'read' })
  @ApiOperation({
    summary: 'Open a shared photo or video (link token in X-Link-Token)',
    description:
      'Metadata-stripped: media type and dimensions only, plus a short-lived presigned URL of the ' +
      'original (inline) and of its thumbnail. Never a filename, location, people, owner or EXIF field. ' +
      'Every failure (unknown, revoked, expired, wrong type, trashed item) is the same 404. The original ' +
      'file is served as stored: EXIF embedded in it, including GPS, is NOT stripped.',
  })
  @ApiHeader({ name: 'X-Link-Token', required: true, description: 'The `lnk_` token from the link fragment' })
  @ApiResponse({ status: 200, description: 'The shared item' })
  @ApiResponse({ status: 404, description: 'Link not found' })
  @ApiResponse({ status: 429, description: 'Too many failed link lookups from this address' })
  media(@CurrentLinkGrant() link: ResolvedLinkGrant): Promise<PublicMediaLinkView> {
    return this.views.mediaView(link);
  }
}

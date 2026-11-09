// =============================================================================
// GET /api/public/links/album: a shared album, opened by its link (RETRO-I4, #578)
// =============================================================================
//
// The platform's public-route pattern (`@marinoscar/platform-api/sharing`):
//   @Public()                  deliberately public; the link authenticates
//   @UseGuards(LinkGrantGuard) resolves `X-Link-Token` (never a path or a query
//                              string), or answers the ONE 404 for every failure
//                              (429 past `links.maxMissesPerIp`), and sets
//                              `Cache-Control: no-store` / `Referrer-Policy: no-referrer`
//   @LinkGrantResource         only `album` links whose role reaches `read`
// Replaces `GET /api/public/shares/:token` for an album share; the bytes are a
// presigned URL now, never proxied (`PublicLinkViewService`).
// =============================================================================

import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@marinoscar/platform-api/identity';
import { CurrentLinkGrant, LinkGrantGuard, LinkGrantResource, type ResolvedLinkGrant } from '@marinoscar/platform-api/sharing';

import { PublicLinkViewService, type PublicAlbumLinkView } from './public-link-view.service';

@ApiTags('Public Sharing')
@Controller('public/links')
@Public()
@UseGuards(LinkGrantGuard)
export class PublicAlbumLinkController {
  constructor(private readonly views: PublicLinkViewService) {}

  @Get('album')
  @LinkGrantResource('album', { action: 'read' })
  @ApiOperation({
    summary: 'Open a shared album (link token in X-Link-Token)',
    description:
      'The album\'s non-trashed members in album order (archived ones included), each metadata-stripped: ' +
      'media type and dimensions, a short-lived presigned URL of the original (inline) and of its thumbnail. ' +
      'No album name, filename, location, people or owner. Every failure is the same 404. Originals are served ' +
      'as stored: EXIF embedded in them, including GPS, is NOT stripped.',
  })
  @ApiHeader({ name: 'X-Link-Token', required: true, description: 'The `lnk_` token from the link fragment' })
  @ApiResponse({ status: 200, description: 'The shared album' })
  @ApiResponse({ status: 404, description: 'Link not found' })
  @ApiResponse({ status: 429, description: 'Too many failed link lookups from this address' })
  album(@CurrentLinkGrant() link: ResolvedLinkGrant): Promise<PublicAlbumLinkView> {
    return this.views.albumView(link);
  }
}

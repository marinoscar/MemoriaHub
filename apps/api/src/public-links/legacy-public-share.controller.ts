// =============================================================================
// GET /api/public/shares/* answers 410 Gone (RETRO-I4, #578; open decision 1)
// =============================================================================
//
// The pre-platform public share API read the token from the PATH
// (`/api/public/shares/:token`) and proxied the media bytes
// (`/:token/media/:idx`). Both are retired: public shares are platform link
// grants, opened through `GET /api/public/links/{media,album}` with the token in
// the `X-Link-Token` header and served as presigned URLs.
//
// Old LINKS keep working without these routes: they are web URLs
// (`<APP_URL>/s/<token>`), and the SPA redirects `/s/:token` to `/s#lnk_<token>`
// (the imported grant's token is `lnk_` + the old one). Only a client that
// called the API directly lands here, and it gets a stable, documented refusal
// rather than a 404 that reads like a revoked link.
//
// One log line per hit, WITHOUT the token, so stragglers can be counted.
// =============================================================================

import { Controller, Get, GoneException, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@marinoscar/platform-api/identity';

/** `details.reason` of the 410. */
export const LEGACY_SHARE_ROUTE_REASON = 'LEGACY_SHARE_ROUTE';

@ApiTags('Public Sharing')
@Controller('public/shares')
@Public()
export class LegacyPublicShareController {
  private readonly logger = new Logger(LegacyPublicShareController.name);

  @Get(':token')
  @HttpCode(HttpStatus.GONE)
  @ApiOperation({
    summary: 'Retired: public share info (410)',
    description:
      'Always 410 with `details.reason: LEGACY_SHARE_ROUTE`. Public shares are link grants since RETRO-I4: ' +
      'open them with `GET /api/public/links/media` or `/album` and the `X-Link-Token` header.',
  })
  @ApiParam({ name: 'token', description: 'An old share token (never read)' })
  @ApiResponse({ status: 410, description: 'Retired route' })
  info(): never {
    return this.gone('info');
  }

  @Get(':token/media/:idx')
  @HttpCode(HttpStatus.GONE)
  @ApiOperation({
    summary: 'Retired: public share byte proxy (410)',
    description:
      'Always 410 with `details.reason: LEGACY_SHARE_ROUTE`. Public media is never streamed through the API ' +
      'any more; the link routes return presigned URLs.',
  })
  @ApiParam({ name: 'token', description: 'An old share token (never read)' })
  @ApiParam({ name: 'idx', description: 'An item index (never read)' })
  @ApiResponse({ status: 410, description: 'Retired route' })
  media(): never {
    return this.gone('media');
  }

  private gone(route: 'info' | 'media'): never {
    // Never the token: it is a credential until the link is revoked.
    this.logger.log(`legacy public share route hit (route=${route})`);
    throw new GoneException({
      message: 'This public share address has moved. Open the shared link in the app instead.',
      details: { reason: LEGACY_SHARE_ROUTE_REASON },
    });
  }
}

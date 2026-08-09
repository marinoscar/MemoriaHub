// =============================================================================
// Public Memory Digest Routes (epic #300, issue #311)
// =============================================================================
//
// Two `@Public()` routes that a digest email needs to work for someone who is
// NOT logged in and may open the mail weeks after it was sent:
//
//   GET  /api/public/memories/digest-image/:token         → thumbnail bytes
//   GET  /api/public/memories/digest-unsubscribe/:token   → confirmation page
//   POST /api/public/memories/digest-unsubscribe/:token   → performs the opt-out
//
// This is a REAL ATTACK SURFACE — three unauthenticated routes reachable by
// anyone with a URL — so the security properties below are the point of the
// file, not decoration. The token codec (digest-token.util.ts) supplies:
//
//   - AN UNFORGEABLE SIGNATURE. HMAC-SHA256 with a key derived from
//     SECRETS_ENCRYPTION_KEY, compared with `timingSafeEqual` over
//     equal-length buffers. There is no unsigned path into either route: the
//     token IS the only parameter, so "forget to check the signature" is not a
//     shape this code can take.
//   - NO CROSS-PURPOSE REPLAY. Image and unsubscribe tokens are signed with
//     DIFFERENT derived sub-keys and each carries its purpose inside the signed
//     payload, so an image token presented to the unsubscribe route fails the
//     signature check, and would fail the purpose check even if a future
//     refactor accidentally shared a key.
//   - NO CROSS-RESOURCE REPLAY. The signed payload names exactly one media item
//     (or one user). Swapping the id invalidates the signature; there is no
//     wildcard token, and no token that means "any thumbnail".
//   - NO EXTENSION. `exp` is inside the signature, so a URL cannot be edited to
//     outlive its window. Expiry is the ONLY revocation mechanism — deliberate,
//     since the epic rejected a token table — which is why the image capability
//     is deliberately narrow (below).
//
// AND THIS FILE ADDS:
//
//   - THUMBNAILS ONLY, NEVER ORIGINALS. The image route resolves the item's
//     `metadata.thumbnailStorageKey` and streams THAT key. The original's key is
//     never read, so no token — valid, expired, or forged — can reach full-
//     resolution bytes, and a media item whose thumbnail has not been generated
//     yet simply 404s rather than falling back to the original.
//   - NO ENUMERATION. Every failure — malformed token, bad signature, wrong
//     purpose, expired, unknown media item, deleted media item, missing
//     thumbnail — raises the SAME bare `NotFoundException`. The route is not an
//     oracle for which media ids or user ids exist. (Same posture as
//     public-share.controller.ts and the notification `:id` routes.)
//   - GET NEVER MUTATES. Unsubscribing is a POST. Mail clients, security
//     scanners and link prefetchers follow every GET in a message; if GET
//     unsubscribed, a corporate link-scanner would silently opt out every
//     recipient it protected. The GET renders a confirmation page whose only
//     control is a form that POSTs the same token — and RFC 8058 one-click,
//     which mail clients trigger from the `List-Unsubscribe-Post` header, POSTs
//     directly to the same URL.
//   - NO REFLECTION. Neither route echoes any part of the token, and the
//     confirmation page contains no user-supplied string at all, so there is
//     nothing to escape and no XSS surface.
// =============================================================================

import {
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { Readable } from 'stream';

import { Public } from '../../auth/decorators/public.decorator';
import { MediaThumbnailService } from '../../media/media-thumbnail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageProviderResolver } from '../../storage/providers/storage-provider.resolver';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../../storage/providers/storage-provider.interface';
import { UserSettingsService } from '../../settings/user-settings/user-settings.service';
import { PatchUserSettingsDto } from '../../settings/dto/update-user-settings.dto';
import {
  verifyDigestImageToken,
  verifyDigestUnsubscribeToken,
} from './digest-token.util';
import { unsubscribeConfirmPage, unsubscribeDonePage } from './unsubscribe-page';

@ApiTags('Public Memories')
@Controller('public/memories')
export class PublicMemoryDigestController {
  private readonly logger = new Logger(PublicMemoryDigestController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly thumbnails: MediaThumbnailService,
    private readonly storageResolver: StorageProviderResolver,
    private readonly userSettings: UserSettingsService,
    @Inject(STORAGE_PROVIDER) private readonly fallbackProvider: StorageProvider,
  ) {}

  // ===========================================================================
  // Image
  // ===========================================================================

  /**
   * Stream the THUMBNAIL of one media item named by a signed token.
   *
   * Bytes are proxied rather than redirected to a signed storage URL for the
   * same reason the public share route proxies: the storage URL — and the
   * bucket layout it reveals — never leaves the server. Cached publicly and
   * immutably because a thumbnail's bytes never change for a given key and the
   * token is already the access control.
   */
  @Get('digest-image/:token')
  @Public()
  @ApiOperation({ summary: 'Stream a digest cover thumbnail (no auth required)' })
  @ApiParam({ name: 'token', description: 'HMAC-signed digest image token' })
  @ApiResponse({ status: 200, description: 'Thumbnail bytes (JPEG)' })
  @ApiResponse({ status: 404, description: 'Invalid, expired, or unknown token' })
  async digestImage(
    @Param('token') token: string,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const mediaItemId = verifyDigestImageToken(token);
    // Bad signature / wrong purpose / expired / malformed — all identical.
    if (!mediaItemId) throw new NotFoundException();

    const item = await this.prisma.mediaItem.findFirst({
      where: {
        id: mediaItemId,
        // A trashed item's digest link goes dark immediately. Archive does NOT
        // block access (an archived item is still the user's own content and
        // the same policy the public-share route applies), but a soft-deleted
        // one must stop serving even though its bytes still exist until the
        // purge runs.
        deletedAt: null,
      },
      select: { metadata: true },
    });
    if (!item) throw new NotFoundException();

    // THUMBNAIL ONLY. The original's storage key is deliberately not selected
    // above, so there is no code path here that could serve it.
    const thumbnailKey = this.thumbnails.extractThumbKey(item.metadata);
    if (!thumbnailKey) throw new NotFoundException();

    const thumbObject = await this.prisma.storageObject.findUnique({
      where: { storageKey: thumbnailKey },
      select: { storageProvider: true, bucket: true },
    });

    let stream: Readable;
    try {
      // Route through the provider/bucket recorded on the thumbnail's own
      // StorageObject row — the ACTIVE provider may have changed since the
      // thumbnail was written, and an email link outlives provider migrations
      // by design. Falling back to the statically-configured provider when no
      // row exists mirrors MediaThumbnailService.signThumb's handling of
      // legacy / still-in-flight thumbnails.
      const provider = thumbObject
        ? await this.storageResolver.getProviderFor(
            thumbObject.storageProvider,
            thumbObject.bucket ?? undefined,
          )
        : this.fallbackProvider;
      stream = await provider.download(thumbnailKey);
    } catch (err) {
      // A storage miss must not leak as a 500 with a provider message in it.
      this.logger.warn(
        `Digest thumbnail fetch failed for key=${thumbnailKey}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      throw new NotFoundException();
    }

    // Thumbnails are always JPEG (ThumbnailProcessor), so the type is not
    // derived from anything attacker-influenced.
    void res.header('Content-Type', 'image/jpeg');
    void res.header('Content-Disposition', 'inline');
    void res.header('X-Content-Type-Options', 'nosniff');
    void res.header('Referrer-Policy', 'no-referrer');
    // Long, immutable caching: the bytes behind a storage key never change, and
    // an email client's image proxy (Gmail's, notably) will fetch this once and
    // serve it to the reader forever after.
    void res.header('Cache-Control', 'public, max-age=86400, immutable');
    res.send(stream);
  }

  // ===========================================================================
  // Unsubscribe
  // ===========================================================================

  /**
   * Confirmation page. Renders a form whose only control POSTs the same token.
   * MUST NOT mutate — see the header's "GET never mutates" note.
   */
  @Get('digest-unsubscribe/:token')
  @Public()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Digest unsubscribe confirmation page (no auth required)' })
  @ApiParam({ name: 'token', description: 'HMAC-signed unsubscribe token' })
  @ApiResponse({ status: 200, description: 'HTML confirmation page' })
  @ApiResponse({ status: 404, description: 'Invalid or expired token' })
  unsubscribePage(@Param('token') token: string): string {
    if (!verifyDigestUnsubscribeToken(token)) throw new NotFoundException();
    // The token is echoed ONLY into the form action, and only after verifying
    // its signature — so the value is one this server minted, not attacker
    // text. It is URL-encoded regardless.
    return unsubscribeConfirmPage(encodeURIComponent(token));
  }

  /**
   * Perform the opt-out. Idempotent: unsubscribing twice is a no-op that still
   * renders the success page, which matters because RFC 8058 one-click may be
   * triggered by a mail client at any time, possibly more than once.
   *
   * Writes through `UserSettingsService.patchSettings` rather than touching the
   * JSONB directly, so the value goes through the same zod validation, the same
   * per-namespace merge, and the same version increment as the in-app toggle
   * (#313) that flips it back.
   */
  @Post('digest-unsubscribe/:token')
  @Public()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('Cache-Control', 'no-store')
  @ApiExcludeEndpoint()
  async unsubscribe(@Param('token') token: string): Promise<string> {
    const userId = verifyDigestUnsubscribeToken(token);
    if (!userId) throw new NotFoundException();

    // A token for a user who has since been deleted verifies fine (the
    // signature is over the id, not the row) — resolve it to a 404 rather than
    // letting patchSettings throw a Prisma error.
    const exists = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException();

    // `PatchUserSettingsDto` is a zod-derived class; a structurally-matching
    // literal is what the HTTP path hands it too, after validation.
    await this.userSettings.patchSettings(userId, {
      memories: { emailDigestOptOut: true },
    } as PatchUserSettingsDto);

    this.logger.log(`Memory digest unsubscribe honoured for user ${userId}`);
    return unsubscribeDonePage();
  }
}

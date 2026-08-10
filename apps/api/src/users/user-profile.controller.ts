import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { UpdateUserProfileDto, UserProfileDto } from './dto/user-profile.dto';
import {
  AVATAR_ALLOWED_MIME_TYPES,
  AVATAR_MAX_UPLOAD_BYTES,
  UserAvatarService,
} from './user-avatar.service';

/**
 * Profile picture management (issue #354).
 *
 * AUTH: every handler carries a BARE `@Auth()` — authenticated, any role, no
 * permission — and every self-service route is scoped to the JWT's own
 * `@CurrentUser('id')`. No new RBAC permission was added, deliberately: a user's
 * own profile picture is inherently personal and there is nothing an
 * Admin-gated permission would protect. Same least-privilege rationale as
 * `GET /api/features` and the Notification Center.
 *
 * The bare `@Auth()` is NOT optional. This codebase has no APP_GUARD, so an
 * undecorated handler here would be publicly reachable.
 *
 * ROUTE ORDERING: this controller shares the `users` prefix with UsersController,
 * which declares `@Get(':id')` / `@Patch(':id')` behind a ParseUUIDPipe. It is
 * registered FIRST in UsersModule's `controllers` array so the literal `me`
 * segment is always matched before any parametric route. (Fastify's radix
 * router already prefers static segments over parameters, and none of the `me`
 * routes below is a single-segment path anyway, so this is belt-and-braces —
 * but the ordering is load-bearing documentation for anyone adding a route.)
 */
@ApiTags('Users')
@Controller('users')
export class UserProfileController {
  constructor(private readonly avatarService: UserAvatarService) {}

  // ---------------------------------------------------------------------------
  // GET /api/users/me/profile
  // ---------------------------------------------------------------------------

  @Get('me/profile')
  @Auth()
  @ApiOperation({
    summary: "Get the current user's profile and avatar state",
    description:
      'linkedPerson is null when the account is unlinked, or when the linked ' +
      'person has since been deleted — in which case the last-rendered avatar ' +
      'bytes are still served and the UI should offer a re-link.',
  })
  @ApiResponse({ status: 200, description: 'Profile', type: UserProfileDto })
  async getProfile(@CurrentUser('id') userId: string): Promise<UserProfileDto> {
    return this.avatarService.getProfile(userId);
  }

  // ---------------------------------------------------------------------------
  // PATCH /api/users/me/profile
  // ---------------------------------------------------------------------------

  @Patch('me/profile')
  @Auth()
  @ApiOperation({
    summary: "Update the current user's display name, person link, or avatar source",
    description:
      'Linking a person also re-renders the avatar from that person (unless the ' +
      'same request sets avatarSource explicitly). Unlinking (linkedPersonId: null) ' +
      'deliberately leaves the picture alone.',
  })
  @ApiResponse({ status: 200, description: 'Updated profile', type: UserProfileDto })
  @ApiResponse({
    status: 400,
    description: 'Avatar source not available (no link, or no uploaded picture)',
  })
  @ApiResponse({ status: 404, description: 'Person not found or not visible' })
  async updateProfile(
    @Body() dto: UpdateUserProfileDto,
    @CurrentUser() user: RequestUser,
  ): Promise<UserProfileDto> {
    return this.avatarService.updateProfile(user, dto);
  }

  // ---------------------------------------------------------------------------
  // POST /api/users/me/avatar
  // ---------------------------------------------------------------------------

  @Post('me/avatar')
  @Auth()
  @ApiOperation({
    summary: 'Upload a custom profile picture',
    description:
      'Accepts a single image (max 5 MB). The image is auto-oriented, stripped ' +
      'of EXIF, centre-cropped to a square, and stored as a 512x512 JPEG. Sets ' +
      'avatarSource to "upload".',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Image file',
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 201, description: 'Updated profile', type: UserProfileDto })
  @ApiResponse({ status: 400, description: 'Missing, oversized, or undecodable image' })
  async uploadAvatar(
    @Req() req: FastifyRequest,
    @CurrentUser('id') userId: string,
  ): Promise<UserProfileDto> {
    // Per-request limit override: the global @fastify/multipart registration
    // allows 100 MB for media uploads, which is far too generous for an avatar.
    //
    // `throwFileSizeLimit: false` is deliberate. The plugin default makes
    // toBuffer() reject with its own RequestFileTooLargeError — a plain Error,
    // not an HttpException, so Nest's default filter would turn an oversized
    // avatar into a 500. Opting out gives us the `truncated` flag instead and
    // lets us answer with a 400 that names the limit. The read stays bounded:
    // busboy stops feeding the stream at the limit either way.
    const data = await req.file({
      limits: { fileSize: AVATAR_MAX_UPLOAD_BYTES },
      throwFileSizeLimit: false,
    });

    if (!data) {
      throw new BadRequestException('No file provided');
    }

    const buffer = await data.toBuffer();

    // The flag — not the buffer length — is the authoritative signal, since a
    // truncated read yields exactly the limit's worth of bytes.
    if (data.file.truncated) {
      throw new BadRequestException(
        `Image exceeds the ${Math.round(AVATAR_MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit`,
      );
    }

    return this.avatarService.uploadAvatar(userId, {
      buffer,
      filename: data.filename,
      mimetype: data.mimetype,
    });
  }

  // ---------------------------------------------------------------------------
  // POST /api/users/me/avatar/from-person
  // ---------------------------------------------------------------------------

  @Post('me/avatar/from-person')
  @Auth()
  @ApiOperation({
    summary: 'Re-render the profile picture from the linked person',
    description:
      "Uses the person's chosen profile picture when set, else their cover " +
      'face. Sets avatarSource to "person".',
  })
  @ApiResponse({ status: 201, description: 'Updated profile', type: UserProfileDto })
  @ApiResponse({
    status: 400,
    description: 'No linked person, or the person has no usable picture yet',
  })
  async renderFromPerson(
    @CurrentUser('id') userId: string,
  ): Promise<UserProfileDto> {
    return this.avatarService.renderFromLinkedPerson(userId);
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/users/me/avatar
  // ---------------------------------------------------------------------------

  @Delete('me/avatar')
  @Auth()
  @ApiOperation({
    summary: 'Reset the profile picture to the OAuth provider picture',
    description:
      'Clears the stored avatar and sets avatarSource to "oauth". The person ' +
      'link is KEPT — "this Person is me" stays true regardless of which ' +
      'picture is displayed. Unlink with PATCH { linkedPersonId: null }.',
  })
  @ApiResponse({ status: 200, description: 'Updated profile', type: UserProfileDto })
  async resetAvatar(@CurrentUser('id') userId: string): Promise<UserProfileDto> {
    return this.avatarService.resetAvatar(userId);
  }

  // ---------------------------------------------------------------------------
  // GET /api/users/:id/avatar — byte proxy
  // ---------------------------------------------------------------------------

  /**
   * Stream the derived 512x512 avatar JPEG.
   *
   * WHY a proxy and not a signed storage URL — two independent reasons:
   *
   *  1. A signed URL carries a TTL (24h here), while `User.profileImageUrl` is a
   *     static column read by auth/me, circle member lists, and the admin users
   *     table. A URL that expires is not something a plain column can hold.
   *
   *  2. More importantly, the alternative the People page uses today — hand the
   *     client a signed URL to the ORIGINAL photo and crop it in CSS — would
   *     give every viewer of a member list full-resolution access to a photo
   *     from a circle they may not belong to. Serving only the pre-rendered
   *     square crop, through a route that never reveals a storage URL, makes
   *     that structurally impossible.
   *
   * Authenticated (any role, no new permission): an avatar is visible to anyone
   * who can already see the user in a member list. `immutable` caching is safe
   * because `avatarVersion` regenerates on every change, so the `?v=` in the
   * materialized URL changes with the bytes.
   */
  @Get(':id/avatar')
  @Auth()
  @ApiOperation({ summary: "Stream a user's derived avatar image" })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Avatar JPEG bytes' })
  @ApiResponse({ status: 404, description: 'User has no stored avatar' })
  async proxyAvatar(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const { provider, storageKey } = await this.avatarService.resolveStoredAvatar(id);

    void res.header('Content-Type', 'image/jpeg');
    void res.header('Cache-Control', 'private, max-age=31536000, immutable');
    void res.header('X-Content-Type-Options', 'nosniff');

    res.send(await provider.download(storageKey));
  }
}

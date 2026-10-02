import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { ErrorDto } from '../../common/dto/error.dto';
import { AdminReleaseDto, type AdminRelease } from '../dto/android-release.dto';
import {
  ANDROID_RELEASE_REASONS,
  APK_FILE_FIELD,
  APK_UPLOAD_LIMITS,
  DEFAULT_ANDROID_PACKAGE_NAME,
  MAX_APK_BYTES,
  MAX_RELEASE_NOTES_LENGTH,
  MAX_VERSION_CODE,
  MAX_VERSION_NAME_LENGTH,
} from './android-release.constants';
import { AndroidReleaseService } from './android-release.service';

// =============================================================================
// /api/admin/android-app/releases — hosted APKs (issue #504, epic #498)
// =============================================================================
//
//   POST   /api/admin/android-app/releases                    system_settings:write
//   GET    /api/admin/android-app/releases                    system_settings:read
//   POST   /api/admin/android-app/releases/:id/make-current   system_settings:write
//   DELETE /api/admin/android-app/releases/:id                system_settings:write
//
// The same strings as the rest of the Android app settings page
// (`android-app.controller.ts`), so the admin card's permission stays exact.
// The CLI (`memoriahub android publish`) calls these with a PAT.
// =============================================================================

const MAX_MB = MAX_APK_BYTES / (1024 * 1024);
const RELEASE_ID_PARAM = { name: 'id', type: String, format: 'uuid', description: 'The release id.' } as const;
const UNAUTHENTICATED = { status: 401, description: 'Not authenticated', type: ErrorDto } as const;
const NO_READ = { status: 403, description: 'Missing system_settings:read', type: ErrorDto } as const;
const NO_WRITE = { status: 403, description: 'Missing system_settings:write', type: ErrorDto } as const;
const NOT_FOUND = { status: 404, description: '`RELEASE_NOT_FOUND`', type: ErrorDto } as const;

@ApiTags('Android app')
@Controller('admin/android-app/releases')
export class AndroidReleaseAdminController {
  constructor(private readonly releases: AndroidReleaseService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Upload an Android APK release (Admin only)',
    description:
      `Multipart upload: the APK in the \`${APK_FILE_FIELD}\` file field plus text fields \`packageName\`, ` +
      '`versionName`, `versionCode`, `signingSha256` and optional `notes`, `makeCurrent` (default `true`) and ' +
      '`force` (default `false`). Send the text fields before the file to be refused before any byte is stored. ' +
      `The file is streamed to object storage (never buffered), must start with the ZIP signature and be at most ` +
      `${MAX_MB} MB; its SHA-256 and size are computed while it streams. \`versionCode\` is an integer 1..` +
      `${MAX_VERSION_CODE}, \`versionName\` at most ${MAX_VERSION_NAME_LENGTH} characters of ` +
      '`[0-9A-Za-z._+-]`, `notes` at most ' +
      `${MAX_RELEASE_NOTES_LENGTH} characters, \`signingSha256\` the signing certificate SHA-256 (colon-separated ` +
      'or 64 hex digits, stored uppercase colon-separated).\n\n' +
      'Refusals (`details.reason`): `RELEASE_NOT_AN_APK`, `RELEASE_INVALID_UPLOAD` (400); `RELEASE_TOO_LARGE` ' +
      '(413); `RELEASE_VERSION_EXISTS` (409, that package and versionCode exist); `RELEASE_VERSION_NOT_NEWER` ' +
      '(409, making it current would not raise the current release\'s versionCode for the same package; send ' +
      '`force=true` to override); `RELEASE_CURRENT_CONFLICT` (409, a concurrent make-current). 503 when object ' +
      'storage is not configured (`STORAGE_NOT_CONFIGURED`).\n\n' +
      'Made current, the release\'s (packageName, signingSha256) is added to the trusted Android apps ' +
      '(`/.well-known/assetlinks.json`) when absent. The APK is written to the active storage provider under ' +
      '`android-releases/<id>.apk`; `sizeBytes` is a decimal string. Audited (`android_app.release.uploaded`).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [APK_FILE_FIELD, 'packageName', 'versionName', 'versionCode', 'signingSha256'],
      properties: {
        packageName: { type: 'string', example: DEFAULT_ANDROID_PACKAGE_NAME },
        versionName: { type: 'string', example: '0.1.0' },
        versionCode: { type: 'integer', example: 1 },
        signingSha256: { type: 'string', description: 'AA:BB:… (32 bytes)' },
        notes: { type: 'string' },
        makeCurrent: { type: 'boolean', default: true },
        force: { type: 'boolean', default: false },
        [APK_FILE_FIELD]: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'The stored release', type: AdminReleaseDto })
  @ApiResponse({ status: 400, description: '`RELEASE_NOT_AN_APK`, `RELEASE_INVALID_UPLOAD`', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse({
    status: 409,
    description: '`RELEASE_VERSION_EXISTS`, `RELEASE_VERSION_NOT_NEWER`, `RELEASE_CURRENT_CONFLICT`',
    type: ErrorDto,
  })
  @ApiResponse({ status: 413, description: `\`RELEASE_TOO_LARGE\` (over ${MAX_MB} MB)`, type: ErrorDto })
  @ApiResponse({ status: 503, description: '`STORAGE_NOT_CONFIGURED`', type: ErrorDto })
  async upload(@Req() req: FastifyRequest, @CurrentUser('id') userId: string): Promise<AdminRelease> {
    if (!req.isMultipart()) {
      throw new BadRequestException({
        message: `Expected multipart/form-data with the APK in the "${APK_FILE_FIELD}" field.`,
        details: { reason: ANDROID_RELEASE_REASONS.INVALID_UPLOAD },
      });
    }

    // 503 before a byte of the body is read when there is nowhere to put it.
    const target = await this.releases.resolveUploadTarget();

    // The plugin's global `fileSize` (100 MB, main.ts) is replaced for this
    // route. An over-limit file is reported by `ApkInspector` (413), whatever
    // the plugin's `throwFileSizeLimit` default.
    const parts = req.parts({ limits: { ...APK_UPLOAD_LIMITS } });
    return this.releases.upload(parts, userId, target);
  }

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'List Android APK releases (Admin only)',
    description: 'Every uploaded release, newest first; `isCurrent` marks the one users are offered.',
  })
  @ApiResponse({ status: 200, description: 'Every release, newest first', type: [AdminReleaseDto] })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_READ)
  list(): Promise<AdminRelease[]> {
    return this.releases.list();
  }

  @Post(':id/make-current')
  @HttpCode(HttpStatus.OK)
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Make an Android release current (Admin only)',
    description:
      'Offers this release to users and devices; the previous current release stops being current in the same ' +
      'transaction. Any release may be made current, a lower versionCode included (a rollback: devices already ' +
      'on a newer build cannot install it, Android refuses downgrades). Adds the release\'s signing key to the ' +
      'trusted Android apps when absent. Idempotent. `RELEASE_CURRENT_CONFLICT` (409) when a concurrent ' +
      'make-current won. Audited (`android_app.release.made_current`).',
  })
  @ApiParam(RELEASE_ID_PARAM)
  @ApiResponse({ status: 200, description: 'The release, now current', type: AdminReleaseDto })
  @ApiResponse({ status: 400, description: 'The id is not a UUID', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`RELEASE_CURRENT_CONFLICT`', type: ErrorDto })
  makeCurrent(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string): Promise<AdminRelease> {
    return this.releases.makeCurrent(id, userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Delete an Android release (Admin only)',
    description:
      'Deletes the stored APK, then the release. The current release cannot be deleted ' +
      '(`RELEASE_IS_CURRENT`, 409). 503 when object storage is not configured (nothing is deleted). Audited ' +
      '(`android_app.release.deleted`). The bytes are deleted through the provider recorded on the release.',
  })
  @ApiParam(RELEASE_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 400, description: 'The id is not a UUID', type: ErrorDto })
  @ApiResponse(UNAUTHENTICATED)
  @ApiResponse(NO_WRITE)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({ status: 409, description: '`RELEASE_IS_CURRENT`', type: ErrorDto })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string): Promise<void> {
    await this.releases.remove(id, userId);
  }
}

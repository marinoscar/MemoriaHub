import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ErrorDto } from '../common/dto/error.dto';
import { AndroidAppService } from './android-app.service';
import {
  AndroidAppResponseDto,
  UpdateAndroidAppDto,
  type AndroidAppResponse,
  type UpdateAndroidAppInput,
} from './dto/android-app.dto';
import { TrustedAppsValidationPipe } from './trusted-apps-validation.pipe';

// =============================================================================
// AndroidAppController (issue #503, epic #498)
// =============================================================================
//
//   GET /api/admin/android-app   system_settings:read
//   PUT /api/admin/android-app   system_settings:write
//
// The same permission strings as the rest of the system settings surface, so
// the admin "Android app" card (#516) declares `system_settings:read`
// (CLAUDE.md, Settings UI Pattern rule 3) and the editor is disabled without
// `:write`. #504 adds the release routes to this module as separate
// controllers under `admin/android-app/releases`.
// =============================================================================

@ApiTags('Android app')
@Controller('admin/android-app')
export class AndroidAppController {
  constructor(private readonly androidApp: AndroidAppService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get the trusted Android apps (Admin)',
    description:
      'The Android apps this deployment trusts to open it as a Trusted Web Activity (full screen, ' +
      'no URL bar), the apps paired Media Sync devices actually report (`reportedApps`: package and ' +
      'signing certificate fingerprint, with a device count, the latest sighting and whether the ' +
      'pair is trusted), and the Digital Asset Links document `/.well-known/assetlinks.json` ' +
      'currently serves.',
  })
  @ApiResponse({ status: 200, description: 'Trusted and reported apps', type: AndroidAppResponseDto })
  async get(): Promise<AndroidAppResponse> {
    return this.androidApp.describe();
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Replace the trusted Android apps (Admin)',
    description:
      'Replaces the whole list (at most 10). `packageName` is an Android application id ' +
      '(`memoriahub.marin.cr`), kept exactly as sent (package names are case-sensitive); `sha256` ' +
      "is the signing certificate's SHA-256 fingerprint, as 32 colon-separated hex bytes (as " +
      '`keytool` prints it) or 64 hex digits, accepted in either case and stored uppercase ' +
      'colon-separated. Repeated pairs are dropped. `/.well-known/assetlinks.json` reflects the ' +
      'change immediately (clients may cache it for five minutes). Audited as ' +
      '`android_app.trusted_apps.updated`. A malformed body is a 400 whose `details.reason` is ' +
      '`TOO_MANY_TRUSTED_APPS`, `INVALID_PACKAGE_NAME`, `INVALID_FINGERPRINT` or (missing list, ' +
      'unknown key) `INVALID_TRUSTED_APPS`, with every problem under `details.issues`.',
  })
  @ApiBody({ type: UpdateAndroidAppDto })
  @ApiResponse({ status: 200, description: 'The saved state', type: AndroidAppResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error (`details.reason`)', type: ErrorDto })
  async replace(
    @Body(TrustedAppsValidationPipe) body: UpdateAndroidAppInput,
    @CurrentUser('id') userId: string,
  ): Promise<AndroidAppResponse> {
    return this.androidApp.replace(body, userId);
  }
}

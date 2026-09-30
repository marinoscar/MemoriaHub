import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS, ROLES } from '../../common/constants/roles.constants';
import {
  GeneratePushConfigDto,
  PushConfigAdminView,
  RemovePushConfigDto,
  RotatePushConfigDto,
  UpdatePushConfigDto,
} from './dto/push-config.dto';
import { PushTestRequestDto, PushTestResponse } from './dto/push-test.dto';
import { PushConfigService } from './push-config.service';
import { PushTestService } from './push-test.service';

// =============================================================================
// PushConfigController (epic #481, issue #483)
// =============================================================================
//
//   GET    /api/admin/push-config           push:read
//   PUT    /api/admin/push-config           push:write
//   POST   /api/admin/push-config/generate  push:write
//   POST   /api/admin/push-config/rotate    push:write
//   DELETE /api/admin/push-config           push:write
//   POST   /api/admin/push-config/test      push:write
//
// `test` is push:write, not push:read: it performs a real signed send and can
// prune the caller's own dead subscriptions — an action, not a read.
//
// The VAPID private key is never returned by any route here — only
// `privateKeyStatus` ({ configured, last4, updatedAt }).
// =============================================================================

@ApiTags('Push Settings')
@Controller('admin/push-config')
export class PushConfigController {
  constructor(
    private readonly pushConfig: PushConfigService,
    private readonly pushTest: PushTestService,
  ) {}

  @Get()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.PUSH_READ] })
  @ApiOperation({
    summary: 'Get the Web Push (VAPID) configuration (Admin)',
    description:
      'Returns `enabled`, the public key, the subject and `privateKeyStatus` ' +
      '({ configured, last4, updatedAt }). The private key itself is never returned.',
  })
  @ApiResponse({ status: 200, description: 'Web Push configuration' })
  async getConfig(): Promise<PushConfigAdminView> {
    return this.pushConfig.describeForAdmin();
  }

  @Put()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.PUSH_WRITE] })
  @ApiOperation({
    summary: 'Update the Web Push switch and subject (Admin)',
    description:
      'Partial update of `{ enabled?, subject? }`. Does not manufacture keys: ' +
      '`enabled: true` with no key pair generated yet is a 409. `subject` must be a ' +
      '`mailto:` address or an `https://` URL; `null` restores the generic fallback.',
  })
  @ApiResponse({ status: 200, description: 'Updated configuration' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 409, description: 'Enabling with no key pair generated' })
  async update(
    @Body() dto: UpdatePushConfigDto,
    @CurrentUser('id') userId: string,
  ): Promise<PushConfigAdminView> {
    return this.pushConfig.update(dto, userId);
  }

  @Post('generate')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.PUSH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate the first VAPID key pair and enable Web Push (Admin)',
    description:
      'First-time only: 409 when a key pair already exists — use rotate instead.',
  })
  @ApiResponse({ status: 200, description: 'The generated configuration' })
  @ApiResponse({ status: 409, description: 'Already configured' })
  async generate(
    @Body() dto: GeneratePushConfigDto,
    @CurrentUser('id') userId: string,
  ): Promise<PushConfigAdminView> {
    return this.pushConfig.generate(dto, userId);
  }

  @Post('rotate')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.PUSH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the VAPID key pair (Admin)',
    description:
      'Requires `{ "confirmation": "ROTATE" }`. Disruptive: every existing subscription ' +
      'stops receiving pushes until its browser re-subscribes against the new key. ' +
      '409 when nothing is configured yet — use generate.',
  })
  @ApiResponse({ status: 200, description: 'The rotated configuration' })
  @ApiResponse({ status: 400, description: 'Missing or incorrect confirmation' })
  @ApiResponse({ status: 409, description: 'Nothing configured yet' })
  async rotate(
    @Body() dto: RotatePushConfigDto,
    @CurrentUser('id') userId: string,
  ): Promise<PushConfigAdminView> {
    return this.pushConfig.rotate(dto, userId);
  }

  @Delete()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.PUSH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove the Web Push configuration (Admin)',
    description:
      'Requires `{ "confirmation": "REMOVE" }` (deliberately a different word from rotate). ' +
      'Deletes the key pair; every subscription becomes unusable. Returns the empty configuration.',
  })
  @ApiResponse({ status: 200, description: 'The resulting (empty) configuration' })
  @ApiResponse({ status: 400, description: 'Missing or incorrect confirmation' })
  async remove(
    @Body() dto: RemovePushConfigDto,
    @CurrentUser('id') userId: string,
  ): Promise<PushConfigAdminView> {
    return this.pushConfig.remove(dto, userId);
  }

  @Post('test')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.PUSH_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Send a test push to the caller's own devices, with diagnostics (Admin)",
    description:
      "Sends a real signed push to the calling admin's OWN subscriptions only and reports " +
      'config, browser and per-device delivery diagnostics plus plain-English hints. ' +
      'Always 200 — a failed send is the diagnostic. Writes no notification row. ' +
      'Never returns the private key, subscription keys, or a full endpoint.',
  })
  @ApiResponse({ status: 200, description: 'Diagnostics and per-subscription results' })
  async test(
    @Body() dto: PushTestRequestDto,
    @CurrentUser('id') userId: string,
  ): Promise<PushTestResponse> {
    return this.pushTest.runTest(userId, dto);
  }
}

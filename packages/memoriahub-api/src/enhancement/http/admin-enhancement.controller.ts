import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { MemoriahubAuth } from '../../core/index.js';
import { ENHANCEMENT_PERMISSIONS as PERMISSIONS, ENHANCEMENT_ROLES as ROLES } from '../constants.js';
import { MediaEnhancementService } from '../media-enhancement.service.js';

/**
 * `GET /api/admin/memoriahub-ai/enhance/status`: the admin status endpoint for the AI Picture Enhancer — backs the Doctor
 * `ai.pictureEnhancer` check and the settings UI. Reuses the existing
 * system-settings read permission (no new scope), Admin role. Mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Admin: AI Picture Enhancer')
@ApiBearerAuth('JWT-auth')
@Controller('admin/memoriahub-ai/enhance')
export class AdminEnhancementController {
  constructor(private readonly service: MediaEnhancementService) {}

  /** Reads the enhancer's feature, provider and key status. */
  @Get('status')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({ summary: 'Get AI Picture Enhancer feature/provider status' })
  @ApiResponse({ status: 200, description: 'Enhancer status' })
  async status() {
    return this.service.getAdminStatus();
  }
}

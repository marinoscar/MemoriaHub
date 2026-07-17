import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MediaEnhancementService } from './media-enhancement.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { ROLES, PERMISSIONS } from '../common/constants/roles.constants';

/**
 * Admin status endpoint for the AI Picture Enhancer — backs the Doctor
 * `ai.pictureEnhancer` check and the settings UI. Reuses the existing
 * system-settings read permission (no new scope), Admin role.
 */
@ApiTags('Admin: AI Picture Enhancer')
@ApiBearerAuth()
@Controller('admin/ai/enhance')
export class AdminEnhancementController {
  constructor(private readonly service: MediaEnhancementService) {}

  @Get('status')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({ summary: 'Get AI Picture Enhancer feature/provider status' })
  @ApiResponse({ status: 200, description: 'Enhancer status' })
  async status() {
    return this.service.getAdminStatus();
  }
}

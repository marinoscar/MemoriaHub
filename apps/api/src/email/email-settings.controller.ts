import { Controller, Get, Put, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { EmailSettingsService } from './email-settings.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { UpdateEmailSettingsDto } from './dto/update-email-settings.dto';
import { TestEmailDto } from './dto/test-email.dto';

@ApiTags('Email Settings')
@ApiBearerAuth('JWT-auth')
@Controller('email-settings')
export class EmailSettingsController {
  constructor(private readonly emailSettingsService: EmailSettingsService) {}

  @Get()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.EMAIL_SETTINGS_READ] })
  @ApiOperation({ summary: 'Get email provider settings (Admin)' })
  @ApiResponse({ status: 200, description: 'Masked email settings' })
  async getSettings() {
    return this.emailSettingsService.getMaskedSettings();
  }

  @Put()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.EMAIL_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Update email provider settings (Admin)' })
  @ApiResponse({ status: 200, description: 'Updated (masked) email settings' })
  async updateSettings(
    @Body() dto: UpdateEmailSettingsDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.emailSettingsService.updateSettings(dto, userId);
  }

  @Post('test')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.EMAIL_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Send a test email (Admin)' })
  @ApiResponse({ status: 200, description: 'Test send result' })
  async sendTest(@Body() dto: TestEmailDto) {
    return this.emailSettingsService.sendTest(dto.recipient);
  }
}

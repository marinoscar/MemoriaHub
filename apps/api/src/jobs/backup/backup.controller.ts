import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Param,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { BackupService } from './backup.service';
import { TriggerBackupDto } from './dto/trigger-backup.dto';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ROLES, PERMISSIONS } from '../../common/constants/roles.constants';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';

@ApiTags('Admin - Backup')
@Controller('admin/backup')
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @Post()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BACKUP_RUN] })
  @ApiOperation({ summary: 'Trigger local-drive backup replication' })
  async triggerBackup(
    @Body() dto: TriggerBackupDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.backupService.runBackup(dto, user.id);
  }

  @Get('runs')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BACKUP_READ] })
  @ApiOperation({ summary: 'List recent backup runs' })
  async listRuns(@Query('limit') limit?: string) {
    return this.backupService.getRecentRuns(limit ? Number(limit) : 20);
  }

  @Get('status')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BACKUP_READ] })
  @ApiOperation({ summary: 'List recent backup runs (alias for /runs)' })
  async listRunsAlias(@Query('limit') limit?: string) {
    return this.backupService.getRecentRuns(limit ? Number(limit) : 20);
  }

  @Get('runs/:runId')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BACKUP_READ] })
  @ApiOperation({ summary: 'Get status of a specific backup run' })
  async getRunStatus(@Param('runId') runId: string) {
    return this.backupService.getRunStatus(runId);
  }

  @Get('objects')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.BACKUP_READ] })
  @ApiOperation({ summary: 'List media objects (returns storageKey + downloadUrl)' })
  async listObjects(@Query('circleId') circleId?: string) {
    return this.backupService.listObjects(circleId);
  }
}

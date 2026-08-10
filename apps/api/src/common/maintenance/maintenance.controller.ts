import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../constants/roles.constants';
import { AllowDuringMaintenance } from './allow-during-maintenance.decorator';
import { MaintenanceModeService } from './maintenance-mode.service';
import { UpdateMaintenanceDto } from './dto/update-maintenance.dto';

/**
 * Admin-controlled maintenance mode (issue #348).
 *
 * `@AllowDuringMaintenance()` is applied at the CONTROLLER level, so both
 * routes are exempt from the block. This is LOCKOUT SAFEGUARD #1 and it is
 * load-bearing: without it, enabling maintenance would 503 the very endpoint
 * needed to disable it again. maintenance.guard.spec.ts carries a regression
 * test asserting this stays true — do not remove either.
 *
 * No new permission: this is a system setting, and the existing
 * `system_settings:read` / `system_settings:write` pair already means
 * "can change global app behavior".
 */
@ApiTags('Maintenance')
@AllowDuringMaintenance()
@Controller('admin/maintenance')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceModeService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get maintenance-mode state (Admin only)',
    description:
      'Returns the effective state plus each contributing layer: the persisted ' +
      'setting, the process-local in-memory override, and the MAINTENANCE_MODE ' +
      'env override (which wins over both, in either direction).',
  })
  @ApiResponse({
    status: 200,
    description: 'Current maintenance-mode state',
    schema: {
      type: 'object',
      properties: {
        active: { type: 'boolean', example: false },
        message: { type: 'string', example: 'Upgrading to v2.4, back by 03:00 UTC' },
        allowAdmins: { type: 'boolean', example: true },
        startedAt: { type: 'string', format: 'date-time', nullable: true },
        startedById: { type: 'string', nullable: true },
        persistedEnabled: { type: 'boolean' },
        inMemoryOverride: { type: 'boolean', nullable: true },
        envOverride: { type: 'boolean', nullable: true },
      },
    },
  })
  async getState() {
    return this.maintenance.getState();
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Enable or disable maintenance mode (Admin only)',
    description:
      'Persists the flag to system_settings so it survives the container restart ' +
      'it was enabled for, and writes an AuditEvent. Setting allowAdmins=false ' +
      'blocks even admins and can lock you out of the UI — recover with the ' +
      'MAINTENANCE_MODE=false env break-glass (see docs/runbooks/maintenance-mode.md). ' +
      'A MAINTENANCE_MODE env override still wins over whatever is written here.',
  })
  @ApiResponse({ status: 200, description: 'Resulting maintenance-mode state' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async setState(
    @Body() dto: UpdateMaintenanceDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.maintenance.setState(dto, userId);
  }
}

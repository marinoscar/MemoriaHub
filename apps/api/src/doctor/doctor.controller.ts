// =============================================================================
// Doctor Controller
// =============================================================================
//
// Admin-only endpoint that runs an on-demand configuration health sweep.
// Mounted at /api/admin/doctor.
// =============================================================================

import { Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { DoctorService } from './doctor.service';
import { DoctorReport } from './doctor.types';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';

@ApiTags('Admin - Doctor')
@Controller('admin/doctor')
export class DoctorController {
  constructor(private readonly doctorService: DoctorService) {}

  // -------------------------------------------------------------------------
  // POST /admin/doctor/run
  // -------------------------------------------------------------------------

  @Post('run')
  @HttpCode(200)
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({ summary: 'Run an on-demand configuration health sweep (Admin)' })
  @ApiOkResponse({
    description:
      'Diagnostics report grouped into sections (core, auth, storage, AI, face, geo, jobs, ' +
      'nodes, workflows). Computed fresh on every call — nothing is persisted.',
  })
  async runDiagnostics(): Promise<DoctorReport> {
    return this.doctorService.runDiagnostics();
  }
}

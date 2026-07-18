import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS, ROLES } from '../../common/constants/roles.constants';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { WorkflowsAdminService } from './workflows-admin.service';
import { ListAdminWorkflowsQueryDto } from './dto/list-admin-workflows-query.dto';
import { ListAdminWorkflowRunsQueryDto } from './dto/list-admin-workflow-runs-query.dto';

/**
 * Media Workflow Automation — admin control plane (issue #143).
 *
 * Cross-circle oversight for `/admin/settings/workflows`. Feature-gated by
 * `isWorkflowsEnabled` in the service (→ 404 when off). Reads require Admin +
 * system_settings:read / jobs:read; the admin override (disable) requires
 * system_settings:write and the runaway-run cancel requires jobs:write —
 * mirroring the admin jobs/nodes controllers.
 */
@ApiTags('Admin - Workflows')
@ApiBearerAuth()
@Controller('admin')
export class WorkflowsAdminController {
  constructor(private readonly adminService: WorkflowsAdminService) {}

  // -------------------------------------------------------------------------
  // GET /admin/workflows/stats  (declared before the :id route for clarity)
  // -------------------------------------------------------------------------

  @Get('workflows/stats')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({ summary: 'Workflow KPI aggregate for the admin dashboard strip (Admin)' })
  @ApiResponse({
    status: 200,
    description:
      'KPI strip: runs in the last 7 days, items actioned (succeeded), failures, and currently-running count',
  })
  async stats() {
    return this.adminService.getStats();
  }

  // -------------------------------------------------------------------------
  // GET /admin/workflows
  // -------------------------------------------------------------------------

  @Get('workflows')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({ summary: 'List every workflow across all circles (Admin, paginated)' })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiQuery({ name: 'circleId', type: String, required: false, format: 'uuid' })
  @ApiQuery({ name: 'trigger', required: false, enum: ['manual', 'on_media_enriched', 'scheduled'] })
  @ApiQuery({ name: 'enabled', required: false, enum: ['true', 'false'] })
  @ApiResponse({
    status: 200,
    description:
      'Workflows with circle, creator, last-run summary, and matched/actioned totals; plus pagination meta',
  })
  async listWorkflows(@Query() query: ListAdminWorkflowsQueryDto) {
    return this.adminService.listWorkflows(query);
  }

  // -------------------------------------------------------------------------
  // GET /admin/workflow-runs
  // -------------------------------------------------------------------------

  @Get('workflow-runs')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_READ] })
  @ApiOperation({ summary: 'List workflow runs across all circles for oversight (Admin, paginated)' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiQuery({ name: 'circleId', type: String, required: false, format: 'uuid' })
  @ApiQuery({ name: 'workflowId', type: String, required: false, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Runs with workflow + circle summary and counts; pagination meta' })
  async listRuns(@Query() query: ListAdminWorkflowRunsQueryDto) {
    return this.adminService.listRuns(query);
  }

  // -------------------------------------------------------------------------
  // POST /admin/workflows/:id/disable — admin override
  // -------------------------------------------------------------------------

  @Post('workflows/:id/disable')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Force-disable a workflow regardless of circle membership (Admin override)',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Workflow disabled' })
  @ApiResponse({ status: 404, description: 'Workflow not found or feature disabled' })
  async disableWorkflow(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.adminService.disableWorkflow(id, user.id);
  }

  // -------------------------------------------------------------------------
  // POST /admin/workflow-runs/:id/cancel — cancel a runaway run app-wide
  // -------------------------------------------------------------------------

  @Post('workflow-runs/:id/cancel')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a runaway workflow run app-wide (Admin override)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run cancelled' })
  @ApiResponse({ status: 400, description: 'Run already finished' })
  @ApiResponse({ status: 404, description: 'Run not found or feature disabled' })
  async cancelRun(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.adminService.cancelRun(id, user);
  }
}

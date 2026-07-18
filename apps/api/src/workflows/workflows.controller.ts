import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { WorkflowsService } from './workflows.service';
import { WorkflowRunService } from './runs/workflow-run.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { ListWorkflowsQueryDto } from './dto/list-workflows-query.dto';
import { PreviewWorkflowDto } from './dto/preview-workflow.dto';
import { CreateRunDto } from './runs/dto/create-run.dto';
import { ListRunsQueryDto } from './runs/dto/list-runs-query.dto';

/**
 * Media Workflow Automation — Phase 1 API (definition, validation, preview).
 * All routes are circle-scoped and feature-gated by `features.workflows` +
 * `WORKFLOWS_ENABLED`. Writes require the system `media:write` permission plus
 * the per-circle `collaborator` role; reads require `media:read` plus `viewer`
 * (per-circle roles are enforced in the service, mirroring bulk-media ops).
 */
@ApiTags('Workflows')
@ApiBearerAuth()
@Controller('workflows')
export class WorkflowsController {
  constructor(
    private readonly workflowsService: WorkflowsService,
    private readonly runService: WorkflowRunService,
  ) {}

  @Post()
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Create a workflow (circle collaborator)' })
  @ApiResponse({ status: 201, description: 'Workflow created' })
  @ApiResponse({ status: 400, description: 'Invalid definition or per-circle cap reached' })
  @ApiResponse({ status: 404, description: 'Feature disabled or circle not found' })
  async create(@Body() dto: CreateWorkflowDto, @CurrentUser() user: RequestUser) {
    return this.workflowsService.createWorkflow(dto, user);
  }

  @Get()
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List workflows in a circle (paginated)' })
  @ApiQuery({ name: 'circleId', type: String, required: true, format: 'uuid' })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiResponse({ status: 200, description: 'Workflows listed' })
  async list(@Query() query: ListWorkflowsQueryDto, @CurrentUser() user: RequestUser) {
    return this.workflowsService.listWorkflows(query, user);
  }

  // Static routes declared before ':id' so they are not captured as a workflow id.
  @Get('subjects')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Get the Subject registry (fields + operators + action catalog)',
  })
  @ApiResponse({ status: 200, description: 'Registry returned' })
  async subjects(@CurrentUser() _user: RequestUser) {
    return this.workflowsService.getSubjects();
  }

  @Post('preview')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview matched count + sample for a definition (stateless)',
  })
  @ApiResponse({ status: 200, description: 'Preview computed' })
  @ApiResponse({ status: 400, description: 'Invalid definition' })
  async preview(@Body() dto: PreviewWorkflowDto, @CurrentUser() user: RequestUser) {
    return this.workflowsService.preview(dto, user);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get a workflow by id' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Workflow returned' })
  @ApiResponse({ status: 404, description: 'Workflow not found or feature disabled' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.workflowsService.getWorkflow(id, user);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Update a workflow (circle collaborator)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Workflow updated' })
  @ApiResponse({ status: 400, description: 'Invalid definition or trigger/cron' })
  @ApiResponse({ status: 404, description: 'Workflow not found or feature disabled' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkflowDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.workflowsService.updateWorkflow(id, dto, user);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a workflow (circle collaborator); cascades runs' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Workflow deleted' })
  @ApiResponse({ status: 404, description: 'Workflow not found or feature disabled' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser): Promise<void> {
    await this.workflowsService.deleteWorkflow(id, user);
  }

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  @Post(':id/run')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a workflow run (circle collaborator)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run created (evaluating)' })
  @ApiResponse({ status: 409, description: 'Too many concurrent runs' })
  @ApiResponse({ status: 404, description: 'Workflow not found or feature disabled' })
  async run(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRunDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.runService.createRun(id, dto, user);
  }

  @Get(':id/runs')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List a workflow’s run history (paginated)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiResponse({ status: 200, description: 'Run history listed' })
  async runs(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListRunsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.runService.listRuns(id, query, user);
  }
}

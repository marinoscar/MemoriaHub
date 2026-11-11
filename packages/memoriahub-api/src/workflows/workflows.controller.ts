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
import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../core/index.js';
import { WorkflowRunService } from './runs/workflow-run.service.js';
import { WORKFLOW_PERMISSIONS as PERMISSIONS } from './workflows.constants.js';
import {
  CreateRunDto,
  CreateWorkflowDto,
  ListRunsQueryDto,
  ListWorkflowsQueryDto,
  PreviewWorkflowDto,
  UpdateWorkflowDto,
} from './workflows.dto.js';
import { WorkflowsService } from './workflows.service.js';

/**
 * Media Workflow Automation — Phase 1 API (definition, validation, preview).
 * All routes are circle-scoped and feature-gated by `features.workflows` +
 * `WORKFLOWS_ENABLED`. Writes require the system `media:write` permission plus
 * the per-circle `collaborator` role; reads require `media:read` plus `viewer`
 * (per-circle roles are enforced in the service, mirroring bulk-media ops).
 *
 * @stability experimental
 */
@ApiTags('Workflows')
@ApiBearerAuth('JWT-auth')
@Controller('workflows')
export class WorkflowsController {
  constructor(
    private readonly workflowsService: WorkflowsService,
    private readonly runService: WorkflowRunService,
  ) {}

  /** Creates a workflow. */
  @Post()
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Create a workflow (circle collaborator)' })
  @ApiResponse({ status: 201, description: 'Workflow created' })
  @ApiResponse({ status: 400, description: 'Invalid definition or per-circle cap reached' })
  @ApiResponse({ status: 404, description: 'Feature disabled or circle not found' })
  async create(@Body() dto: CreateWorkflowDto, @MemoriahubCurrentUser() user: MemoriahubRequestUser) {
    return this.workflowsService.createWorkflow(dto, user);
  }

  /** Lists the workflows of a circle. */
  @Get()
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List workflows in a circle (paginated)' })
  @ApiQuery({ name: 'circleId', type: String, required: true, format: 'uuid' })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiResponse({ status: 200, description: 'Workflows listed' })
  async list(@Query() query: ListWorkflowsQueryDto, @MemoriahubCurrentUser() user: MemoriahubRequestUser) {
    return this.workflowsService.listWorkflows(query, user);
  }

  // Static routes declared before ':id' so they are not captured as a workflow id.
  /** Returns the per-Subject catalog. */
  @Get('subjects')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({
    summary: 'Get the Subject registry (fields + operators + action catalog)',
  })
  @ApiResponse({ status: 200, description: 'Registry returned' })
  async subjects(@MemoriahubCurrentUser() _user: MemoriahubRequestUser) {
    return this.workflowsService.getSubjects();
  }

  /** Previews what a definition matches. */
  @Post('preview')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview matched count + sample for a definition (stateless)',
  })
  @ApiResponse({ status: 200, description: 'Preview computed' })
  @ApiResponse({ status: 400, description: 'Invalid definition' })
  async preview(@Body() dto: PreviewWorkflowDto, @MemoriahubCurrentUser() user: MemoriahubRequestUser) {
    return this.workflowsService.preview(dto, user);
  }

  /** Reads a workflow. */
  @Get(':id')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get a workflow by id' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Workflow returned' })
  @ApiResponse({ status: 404, description: 'Workflow not found or feature disabled' })
  async get(@Param('id', ParseUUIDPipe) id: string, @MemoriahubCurrentUser() user: MemoriahubRequestUser) {
    return this.workflowsService.getWorkflow(id, user);
  }

  /** Updates a workflow. */
  @Patch(':id')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Update a workflow (circle collaborator)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Workflow updated' })
  @ApiResponse({ status: 400, description: 'Invalid definition or trigger/cron' })
  @ApiResponse({ status: 404, description: 'Workflow not found or feature disabled' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkflowDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.workflowsService.updateWorkflow(id, dto, user);
  }

  /** Deletes a workflow. */
  @Delete(':id')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a workflow (circle collaborator); cascades runs' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Workflow deleted' })
  @ApiResponse({ status: 404, description: 'Workflow not found or feature disabled' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @MemoriahubCurrentUser() user: MemoriahubRequestUser): Promise<void> {
    await this.workflowsService.deleteWorkflow(id, user);
  }

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  /** Starts a run. */
  @Post(':id/run')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a workflow run (circle collaborator)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run created (evaluating)' })
  @ApiResponse({ status: 409, description: 'Too many concurrent runs' })
  @ApiResponse({ status: 404, description: 'Workflow not found or feature disabled' })
  async run(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRunDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.runService.createRun(id, dto, user);
  }

  /** Lists a workflow's runs. */
  @Get(':id/runs')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List a workflow’s run history (paginated)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiResponse({ status: 200, description: 'Run history listed' })
  async runs(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListRunsQueryDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.runService.listRuns(id, query, user);
  }
}

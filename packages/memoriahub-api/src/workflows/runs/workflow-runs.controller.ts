import {
  Body,
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
import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../../core/index.js';
import { WORKFLOW_PERMISSIONS as PERMISSIONS } from '../workflows.constants.js';
import { ApproveRunDto, ListRunItemsQueryDto } from '../workflows.dto.js';
import { WorkflowRunService } from './workflow-run.service.js';

/**
 * Media Workflow Automation — run inspection + approval API (issue #140).
 * Feature-gated + circle-scoped in the service. Reads require media:read +
 * per-circle viewer; approve/cancel require media:write + collaborator.
 *
 * @stability experimental
 */
@ApiTags('Workflow Runs')
@ApiBearerAuth('JWT-auth')
@Controller('workflow-runs')
export class WorkflowRunsController {
  constructor(private readonly runService: WorkflowRunService) {}

  /** Reads a run. */
  @Get(':id')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get a workflow run (counts + action summary)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run returned' })
  @ApiResponse({ status: 404, description: 'Run not found or feature disabled' })
  async get(@Param('id', ParseUUIDPipe) id: string, @MemoriahubCurrentUser() user: MemoriahubRequestUser) {
    return this.runService.getRunDetail(id, user);
  }

  /** Lists a run's items. */
  @Get(':id/items')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List a run’s items (paginated, signed thumbnails)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiResponse({ status: 200, description: 'Items listed' })
  async items(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListRunItemsQueryDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.runService.listRunItems(id, query, user);
  }

  /** Approves a run. */
  @Post(':id/approve')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve an awaiting-approval run (circle collaborator)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run approved and executing' })
  @ApiResponse({ status: 400, description: 'Run not awaiting approval or bad confirmation' })
  @ApiResponse({ status: 404, description: 'Run not found or feature disabled' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveRunDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.runService.approveRun(id, dto, user);
  }

  /** Cancels a run. */
  @Post(':id/cancel')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a non-terminal run (circle collaborator)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run cancelled' })
  @ApiResponse({ status: 400, description: 'Run already finished' })
  @ApiResponse({ status: 404, description: 'Run not found or feature disabled' })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @MemoriahubCurrentUser() user: MemoriahubRequestUser) {
    return this.runService.cancelRun(id, user);
  }
}

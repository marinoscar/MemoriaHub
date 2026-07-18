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
import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { WorkflowRunService } from './workflow-run.service';
import { ApproveRunDto } from './dto/approve-run.dto';
import { ListRunItemsQueryDto } from './dto/list-run-items-query.dto';

/**
 * Media Workflow Automation — run inspection + approval API (issue #140).
 * Feature-gated + circle-scoped in the service. Reads require media:read +
 * per-circle viewer; approve/cancel require media:write + collaborator.
 */
@ApiTags('Workflow Runs')
@ApiBearerAuth()
@Controller('workflow-runs')
export class WorkflowRunsController {
  constructor(private readonly runService: WorkflowRunService) {}

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get a workflow run (counts + action summary)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run returned' })
  @ApiResponse({ status: 404, description: 'Run not found or feature disabled' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.runService.getRunDetail(id, user);
  }

  @Get(':id/items')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List a run’s items (paginated, signed thumbnails)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'pageSize', type: Number, required: false })
  @ApiResponse({ status: 200, description: 'Items listed' })
  async items(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListRunItemsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.runService.listRunItems(id, query, user);
  }

  @Post(':id/approve')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve an awaiting-approval run (circle collaborator)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run approved and executing' })
  @ApiResponse({ status: 400, description: 'Run not awaiting approval or bad confirmation' })
  @ApiResponse({ status: 404, description: 'Run not found or feature disabled' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveRunDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.runService.approveRun(id, dto, user);
  }

  @Post(':id/cancel')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a non-terminal run (circle collaborator)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run cancelled' })
  @ApiResponse({ status: 400, description: 'Run already finished' })
  @ApiResponse({ status: 404, description: 'Run not found or feature disabled' })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.runService.cancelRun(id, user);
  }
}

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
import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../../core/index.js';
import { MEDIA_PERMISSIONS as PERMISSIONS } from '../constants/permissions.js';
import { TrashEmptyRunService } from './trash-empty-run.service.js';
import { ListTrashEmptyRunItemsQueryDto } from './trash-empty.dto.js';

/**
 * Empty-Trash at scale — run inspection + cancel API (issue #165).
 * Circle-scoped in the service. Reads require media:read + per-circle viewer;
 * cancel requires media:delete + per-circle circle_admin.
 */
/**
 * The `TrashEmptyRunsController` routes; mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Trash Empty Runs')
@ApiBearerAuth('JWT-auth')
@Controller('trash-empty-runs')
/**
 * Trash empty runs controller.
 *
 * @stability experimental
 */
export class TrashEmptyRunsController {
  constructor(private readonly runService: TrashEmptyRunService) {}

  /** Get a trash-empty run (counters + item status tally). */
  @Get(':id')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get a trash-empty run (counters + item status tally)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run returned' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async get(@Param('id', ParseUUIDPipe) id: string, @MemoriahubCurrentUser() user: MemoriahubRequestUser) {
    return this.runService.getRunDetail(id, user.id, user.permissions);
  }

  /** List a run’s items (paginated, signed thumbnails). */
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
    @Query() query: ListTrashEmptyRunItemsQueryDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.runService.listRunItems(id, query, user.id, user.permissions);
  }

  /** Cancel a non-terminal trash-empty run (circle_admin). */
  @Post(':id/cancel')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_DELETE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a non-terminal trash-empty run (circle_admin)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run cancelled' })
  @ApiResponse({ status: 400, description: 'Run already finished' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @MemoriahubCurrentUser() user: MemoriahubRequestUser) {
    return this.runService.cancelRun(id, user.id, user.permissions);
  }
}

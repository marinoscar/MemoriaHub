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
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { TrashEmptyRunService } from './trash-empty-run.service';
import { ListTrashEmptyRunItemsQueryDto } from './dto/list-trash-empty-run-items-query.dto';

/**
 * Empty-Trash at scale — run inspection + cancel API (issue #165).
 * Circle-scoped in the service. Reads require media:read + per-circle viewer;
 * cancel requires media:delete + per-circle circle_admin.
 */
@ApiTags('Trash Empty Runs')
@ApiBearerAuth()
@Controller('trash-empty-runs')
export class TrashEmptyRunsController {
  constructor(private readonly runService: TrashEmptyRunService) {}

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get a trash-empty run (counters + item status tally)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run returned' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.runService.getRunDetail(id, user.id, user.permissions);
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
    @Query() query: ListTrashEmptyRunItemsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.runService.listRunItems(id, query, user.id, user.permissions);
  }

  @Post(':id/cancel')
  @Auth({ permissions: [PERMISSIONS.MEDIA_DELETE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a non-terminal trash-empty run (circle_admin)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Run cancelled' })
  @ApiResponse({ status: 400, description: 'Run already finished' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.runService.cancelRun(id, user.id, user.permissions);
  }
}

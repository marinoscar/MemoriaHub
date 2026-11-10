import { Controller, Post, Get, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../core/index.js';
import { SEARCH_PERMISSIONS as PERMISSIONS } from './constants.js';
import { SearchQueryDto } from './dto/search-query.dto.js';
import { SearchService } from './search.service.js';

/**
 * `POST /api/search` and `GET /api/search/fields`; mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Search')
@ApiBearerAuth('JWT-auth')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Post()
  @MemoriahubAuth({ permissions: [PERMISSIONS.SEARCH_USE] })
  @ApiOperation({
    summary: 'Deterministic media search',
    description:
      'Search media items within a circle using explicit filter criteria. ' +
      'All filter semantics are identical to GET /api/media. ' +
      'Unknown filter keys are rejected with 400. ' +
      'Returns the same paginated envelope as GET /api/media.',
  })
  @ApiResponse({ status: 200, description: 'Paginated media results' })
  @ApiResponse({ status: 400, description: 'Unknown filter key(s)' })
  @ApiResponse({ status: 403, description: 'Not a member of the circle or insufficient permissions' })
  async search(
    @Body() dto: SearchQueryDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ) {
    return this.searchService.search(dto, user.id, user.permissions);
  }

  @Get('fields')
  @MemoriahubAuth({ permissions: [PERMISSIONS.SEARCH_USE] })
  @ApiOperation({
    summary: 'List searchable fields',
    description:
      'Returns the registry of all available filter dimensions. ' +
      'Frontend uses this to render the filter builder dynamically. ' +
      'The AI agent uses the description + type fields to generate tool schema parameters.',
  })
  @ApiResponse({ status: 200, description: 'Array of searchable field descriptors' })
  async getFields() {
    return this.searchService.getFields();
  }
}

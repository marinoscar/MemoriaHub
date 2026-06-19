import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { TagLabelsService, CreateTagLabelDto, UpdateTagLabelDto } from './tag-labels.service';

@ApiTags('Tag Labels')
@ApiBearerAuth('JWT-auth')
@Controller('tag-labels')
export class TagLabelsController {
  constructor(private readonly tagLabelsService: TagLabelsService) {}

  // --------------------------------------------------------------------------
  // GET /api/tag-labels
  // --------------------------------------------------------------------------

  @Get()
  @Auth({ permissions: [PERMISSIONS.AI_SETTINGS_READ] })
  @ApiOperation({ summary: 'List all tag labels' })
  @ApiResponse({ status: 200, description: 'List of tag labels' })
  async getAll() {
    const labels = await this.tagLabelsService.getAll();
    return { data: labels };
  }

  // --------------------------------------------------------------------------
  // POST /api/tag-labels
  // --------------------------------------------------------------------------

  @Post()
  @Auth({ permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Create a new tag label' })
  @ApiResponse({ status: 201, description: 'Tag label created' })
  @ApiResponse({ status: 409, description: 'Tag label name already exists' })
  async create(@Body() dto: CreateTagLabelDto) {
    const label = await this.tagLabelsService.create(dto);
    return { data: label };
  }

  // --------------------------------------------------------------------------
  // PATCH /api/tag-labels/:id
  // --------------------------------------------------------------------------

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Update a tag label' })
  @ApiParam({ name: 'id', description: 'Tag label ID' })
  @ApiResponse({ status: 200, description: 'Tag label updated' })
  @ApiResponse({ status: 404, description: 'Tag label not found' })
  @ApiResponse({ status: 409, description: 'Tag label name already exists' })
  async update(@Param('id') id: string, @Body() dto: UpdateTagLabelDto) {
    const label = await this.tagLabelsService.update(id, dto);
    return { data: label };
  }

  // --------------------------------------------------------------------------
  // DELETE /api/tag-labels/:id
  // --------------------------------------------------------------------------

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a tag label' })
  @ApiParam({ name: 'id', description: 'Tag label ID' })
  @ApiResponse({ status: 204, description: 'Tag label deleted' })
  @ApiResponse({ status: 404, description: 'Tag label not found' })
  async remove(@Param('id') id: string) {
    await this.tagLabelsService.remove(id);
  }
}

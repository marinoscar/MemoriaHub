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
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
import { parse as csvParse } from 'csv-parse/sync';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import {
  TagLabelsService,
  CreateTagLabelDto,
  UpdateTagLabelDto,
  TagLabelCsvRow,
} from './tag-labels.service';

@ApiTags('Tag Labels')
@ApiBearerAuth('JWT-auth')
@Controller('tag-labels')
export class TagLabelsController {
  constructor(private readonly tagLabelsService: TagLabelsService) {}

  // --------------------------------------------------------------------------
  // GET /api/tag-labels/export
  // Must be declared before :id routes to prevent shadowing.
  // --------------------------------------------------------------------------

  @Get('export')
  @Auth({ permissions: [PERMISSIONS.AI_SETTINGS_READ] })
  @ApiOperation({ summary: 'Export all tag labels as CSV' })
  @ApiResponse({
    status: 200,
    description: 'CSV file with id,name columns ordered by name',
  })
  async exportCsv(@Res() res: FastifyReply): Promise<void> {
    const csv = await this.tagLabelsService.exportToCsv();
    res.raw.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="tag-labels.csv"',
    });
    res.raw.end(csv);
  }

  // --------------------------------------------------------------------------
  // POST /api/tag-labels/import
  // --------------------------------------------------------------------------

  @Post('import')
  @Auth({ permissions: [PERMISSIONS.AI_SETTINGS_WRITE] })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'CSV file with columns: id, name, delete (header row required)',
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
      required: ['file'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Import summary',
    schema: {
      type: 'object',
      properties: {
        created: { type: 'number' },
        updated: { type: 'number' },
        deleted: { type: 'number' },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              row: { type: 'number' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'No file provided or CSV is unparseable/empty' })
  async importCsv(@Req() req: FastifyRequest) {
    const data = await req.file();
    if (!data) {
      throw new BadRequestException('No file provided');
    }

    // Read the multipart file stream into a buffer
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk as Buffer);
    }
    const csvBuffer = Buffer.concat(chunks);

    if (!csvBuffer.length) {
      throw new BadRequestException('Uploaded file is empty');
    }

    let rows: TagLabelCsvRow[];
    try {
      rows = csvParse(csvBuffer, {
        columns: (header: string[]) =>
          header.map((h) => h.trim().toLowerCase()),
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      }) as TagLabelCsvRow[];
    } catch (err: any) {
      throw new BadRequestException(`CSV parse error: ${err.message}`);
    }

    if (!rows.length) {
      throw new BadRequestException('CSV contains no data rows');
    }

    const summary = await this.tagLabelsService.importFromCsv(rows);
    return { data: summary };
  }

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

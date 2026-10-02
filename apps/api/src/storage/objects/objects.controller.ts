import {
  Controller,
  Post,
  Get,
  Delete,
  Patch,
  Put,
  Param,
  Res,
  ParseIntPipe,
  UnsupportedMediaTypeException,
  Body,
  Query,
  Req,
  BadRequestException,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiConsumes,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'stream';
import { ZodValidationPipe } from 'nestjs-zod';

import { Auth } from '../../auth/decorators/auth.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { ObjectsService } from './objects.service';
import {
  InitUploadDto,
  InitUploadResponseDto,
  initUploadSchema,
} from './dto/init-upload.dto';
import {
  CompleteUploadDto,
  completeUploadSchema,
} from './dto/complete-upload.dto';
import {
  ObjectResponseDto,
  UploadStatusResponseDto,
} from './dto/object-response.dto';
import {
  ObjectListQueryDto,
  ObjectListResponseDto,
  objectListQuerySchema,
} from './dto/object-list-query.dto';
import {
  UpdateMetadataDto,
  updateMetadataSchema,
} from './dto/update-metadata.dto';
import {
  DownloadUrlResponseDto,
} from './dto/download-url-response.dto';
import {
  UPLOAD_ERROR_REASONS,
} from './dto/upload-part.dto';
import {
  GetPartUrlsDto,
  GetPartUrlsResponseDto,
  getPartUrlsSchema,
} from './dto/get-part-urls.dto';

@ApiTags('Storage')
@Controller('storage/objects')
@Auth()
export class ObjectsController {
  constructor(private readonly objectsService: ObjectsService) {}

  /**
   * List user's storage objects
   */
  @Get()
  @ApiOperation({
    summary: 'List storage objects',
    description: 'Get paginated list of user\'s storage objects with filtering and sorting',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Items per page (default: 20, max: 100)' })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'uploading', 'processing', 'ready', 'failed'], description: 'Filter by status' })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['createdAt', 'name', 'size'], description: 'Sort field (default: createdAt)' })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'], description: 'Sort order (default: desc)' })
  @ApiResponse({
    status: 200,
    description: 'List retrieved successfully',
  })
  async list(
    @Query(new ZodValidationPipe(objectListQuerySchema)) query: ObjectListQueryDto,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: ObjectListResponseDto }> {
    const result = await this.objectsService.list(query, userId);
    return { data: result };
  }

  /**
   * Get single object by ID
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get storage object',
    description: 'Get metadata for a specific storage object',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'Object ID' })
  @ApiResponse({
    status: 200,
    description: 'Object retrieved successfully',
    type: Object,
  })
  @ApiResponse({
    status: 404,
    description: 'Object not found',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied - you do not own this object',
  })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{ data: ObjectResponseDto }> {
    const result = await this.objectsService.getById(id, user.id, user.permissions);
    return { data: result };
  }

  /**
   * Get signed download URL
   */
  @Get(':id/download')
  @ApiOperation({
    summary: 'Get download URL',
    description: 'Generate a signed URL for downloading a storage object',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'Object ID' })
  @ApiQuery({ name: 'expiresIn', required: false, type: Number, description: 'URL expiration in seconds (default: 3600)' })
  @ApiResponse({
    status: 200,
    description: 'Download URL generated successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Object is not ready for download',
  })
  @ApiResponse({
    status: 404,
    description: 'Object not found',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied - you do not own this object',
  })
  async getDownloadUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('expiresIn') expiresIn: number | undefined,
    @CurrentUser() user: RequestUser,
  ): Promise<{ data: DownloadUrlResponseDto }> {
    const result = await this.objectsService.getDownloadUrl(id, user.id, expiresIn, user.permissions);
    return { data: result };
  }

  /**
   * Delete storage object
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete storage object',
    description: 'Delete a storage object from both storage and database',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'Object ID' })
  @ApiResponse({
    status: 204,
    description: 'Object deleted successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Object not found',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied - you do not own this object',
  })
  async deleteObject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.objectsService.delete(id, user.id, user.permissions);
  }

  /**
   * Update object metadata
   */
  @Patch(':id/metadata')
  @ApiOperation({
    summary: 'Update object metadata',
    description: 'Update metadata for a storage object (merges with existing metadata)',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'Object ID' })
  @ApiResponse({
    status: 200,
    description: 'Metadata updated successfully',
    type: Object,
  })
  @ApiResponse({
    status: 404,
    description: 'Object not found',
  })
  @ApiResponse({
    status: 403,
    description: 'Access denied - you do not own this object',
  })
  async updateMetadata(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateMetadataSchema)) dto: UpdateMetadataDto,
    @CurrentUser() user: RequestUser,
  ): Promise<{ data: ObjectResponseDto }> {
    const result = await this.objectsService.updateMetadata(id, dto, user.id, user.permissions);
    return { data: result };
  }

  /**
   * Initialize resumable multipart upload
   */
  @Post('upload/init')
  @ApiOperation({
    summary: 'Initialize resumable upload',
    description: 'Start a multipart upload for large files',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initialized successfully',
    type: Object,
  })
  async initUpload(
    @Body(new ZodValidationPipe(initUploadSchema)) dto: InitUploadDto,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: InitUploadResponseDto }> {
    const result = await this.objectsService.initUpload(dto, userId);
    return { data: result };
  }

  /**
   * Get upload status and progress
   */
  @Get(':id/upload/status')
  @ApiOperation({
    summary: 'Get upload status',
    description: 'Check progress of a resumable upload',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload status retrieved',
    type: Object,
  })
  async getUploadStatus(
    @Param('id') objectId: string,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: UploadStatusResponseDto }> {
    const result = await this.objectsService.getUploadStatus(objectId, userId);
    return { data: result };
  }

  /**
   * Mint presigned upload URLs for arbitrary part numbers.
   * Clients that need more than the initial 10 URLs (files >100 MB at 10 MB
   * part size) call this endpoint with a list of part numbers to get fresh
   * presigned PUT URLs. At most 100 part numbers per call.
   */
  @Post(':id/upload/part-urls')
  @ApiOperation({
    summary: 'Get presigned upload URLs for parts',
    description:
      'Mint fresh presigned PUT URLs for the given part numbers of an in-progress multipart upload. Supports up to 100 part numbers per request.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'StorageObject ID' })
  @ApiResponse({
    status: 201,
    description: 'Presigned URLs generated',
    type: Object,
  })
  @ApiResponse({ status: 400, description: 'No active multipart upload or invalid input' })
  @ApiResponse({ status: 403, description: 'Access denied - you do not own this upload' })
  @ApiResponse({ status: 404, description: 'Upload not found' })
  async getPartUrls(
    @Param('id', ParseUUIDPipe) objectId: string,
    @Body(new ZodValidationPipe(getPartUrlsSchema)) dto: GetPartUrlsDto,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: GetPartUrlsResponseDto }> {
    const result = await this.objectsService.getPartUrls(objectId, dto, userId);
    return { data: result };
  }

  /**
   * Receive one multipart part through the API (issue #506).
   *
   * Used only when the upload's storage provider has no URL a device can PUT
   * to (the `local` provider): `upload/init` and `upload/part-urls` then hand
   * out this route with `partUploadAuth: 'bearer'`. The raw body is streamed
   * straight to disk — the route's content-type parser (see
   * `common/fastify-setup.ts`) passes the request stream through untouched,
   * so a part is never buffered in memory.
   */
  @Put(':id/upload/parts/:partNumber')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Upload one part through the API',
    description:
      'Upload the raw bytes of one part of a multipart upload whose storage provider has no ' +
      'presigned part URLs (the local provider). Use the URLs returned by upload/init and ' +
      'upload/part-urls; when their partUploadAuth is "bearer" they point here and need the ' +
      'usual Authorization: Bearer header (JWT or PAT). Send the bytes as ' +
      'application/octet-stream (any non-JSON, non-text type is accepted). Each part except ' +
      'the last must be exactly partSize bytes. Idempotent: re-sending a part replaces it. ' +
      'Returns an empty body and the part MD5 as a quoted ETag header, to pass to complete.',
  })
  @ApiConsumes('application/octet-stream')
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'StorageObject ID' })
  @ApiParam({ name: 'partNumber', type: Number, description: 'Part number, 1..totalParts' })
  @ApiResponse({
    status: 200,
    description: 'Part stored. Empty body; the ETag header carries its quoted MD5',
  })
  @ApiResponse({
    status: 400,
    description:
      'Upload not in progress, provider takes presigned parts, part number out of range, or ' +
      'wrong part size (details.reason)',
  })
  @ApiResponse({ status: 403, description: 'Access denied - you do not own this upload' })
  @ApiResponse({ status: 404, description: 'Upload not found' })
  @ApiResponse({
    status: 409,
    description: 'details.reason UPLOAD_SESSION_INVALID: the session is gone; abort and re-init',
  })
  @ApiResponse({ status: 415, description: 'Body was not sent as raw bytes' })
  async uploadPart(
    @Param('id', ParseUUIDPipe) objectId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    // The raw-part parser hands the body over as the request stream. Anything
    // else means a JSON or text parser already consumed it.
    if (!(req.body instanceof Readable)) {
      throw new UnsupportedMediaTypeException({
        message: 'Send the part as raw bytes (Content-Type: application/octet-stream)',
        details: { reason: UPLOAD_ERROR_REASONS.RAW_BODY_REQUIRED },
      });
    }

    const lengthHeader = req.headers['content-length'];
    const declaredLength =
      typeof lengthHeader === 'string' && /^\d+$/.test(lengthHeader)
        ? Number(lengthHeader)
        : undefined;

    const result = await this.objectsService.uploadPart(
      objectId,
      partNumber,
      userId,
      req.body,
      declaredLength,
    );

    // Answer exactly like an S3 presigned part PUT: 200, empty body, quoted
    // MD5 in ETag (docs/specs/android-media-sync.md §6.1). Clients read the
    // header and need no second code path for API part URLs.
    reply.status(HttpStatus.OK).header('ETag', result.eTag).send();
  }

  /**
   * Complete multipart upload
   */
  @Post(':id/upload/complete')
  @ApiOperation({
    summary: 'Complete resumable upload',
    description: 'Finalize a multipart upload after all parts are uploaded',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed successfully',
    type: Object,
  })
  @ApiResponse({
    status: 409,
    description:
      'details.reason UPLOAD_SESSION_INVALID: the session is gone, re-initialize; or ' +
      'UPLOAD_PARTS_MISSING: re-send details.partNumbers and complete again',
  })
  async completeUpload(
    @Param('id') objectId: string,
    @Body(new ZodValidationPipe(completeUploadSchema)) dto: CompleteUploadDto,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: ObjectResponseDto }> {
    const result = await this.objectsService.completeUpload(
      objectId,
      dto,
      userId,
    );
    return { data: result };
  }

  /**
   * Abort multipart upload
   */
  @Delete(':id/upload/abort')
  @ApiOperation({
    summary: 'Abort resumable upload',
    description: 'Cancel an in-progress multipart upload',
  })
  @ApiResponse({
    status: 204,
    description: 'Upload aborted successfully',
  })
  async abortUpload(
    @Param('id') objectId: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.objectsService.abortUpload(objectId, userId);
  }

  /**
   * Simple upload for smaller files (< 100MB)
   */
  @Post()
  @ApiOperation({
    summary: 'Simple file upload',
    description: 'Direct upload for files under 100MB',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'File to upload',
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'File uploaded successfully',
    type: Object,
  })
  async simpleUpload(
    @Req() req: FastifyRequest,
    @CurrentUser('id') userId: string,
  ): Promise<{ data: ObjectResponseDto }> {
    // Get multipart file from request
    const data = await req.file();

    if (!data) {
      throw new BadRequestException('No file provided');
    }

    const result = await this.objectsService.simpleUpload(
      {
        filename: data.filename,
        mimetype: data.mimetype,
        file: data.file,
      },
      userId,
    );

    return { data: result };
  }
}

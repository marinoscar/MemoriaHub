import { Controller, Post, Param, Body, Logger } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiProperty,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { OrientationOp } from '@marinoscar/memoriahub-compute/image';
import { MemoriahubAuth, MemoriahubCurrentUser, type MemoriahubRequestUser } from '../../core/index.js';
import { MEDIA_PERMISSIONS as PERMISSIONS } from '../constants/permissions.js';
import { MediaOrientationEditService } from './media-orientation-edit.service.js';

const ORIENTATION_OPS: OrientationOp[] = [
  'rotate_left',
  'rotate_right',
  'flip_horizontal',
  'flip_vertical',
];

/**
 * Body of `POST /api/media/:id/edit/orientation`.
 *
 * @stability experimental
 */
export class OrientationEditDto {
  @ApiProperty({
    description: 'Orientation operation to apply to the photo original',
    enum: ORIENTATION_OPS,
    example: 'rotate_right',
  })
  op!: OrientationOp;
}

/**
 * POST /api/media/:id/edit/orientation
 *
 * Destructively rotates/flips a photo's ORIGINAL stored bytes, re-encodes to
 * JPEG, overwrites the same storage key, regenerates the thumbnail, and
 * re-enqueues face detection. Photos only. Guard/RBAC model mirrors the
 * "Retry thumbnail" action (media:write permission + per-circle collaborator
 * role, enforced inside the service). Mounted by the host in its own module.
 *
 * @stability experimental
 */
@ApiTags('Media')
@ApiBearerAuth('JWT-auth')
@Controller()
export class MediaOrientationEditController {
  private readonly logger = new Logger(MediaOrientationEditController.name);

  constructor(
    private readonly orientationEditService: MediaOrientationEditService,
  ) {}

  /** Rotates or flips a photo's original bytes (collaborator role; photos only). */
  @Post('media/:id/edit/orientation')
  @MemoriahubAuth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({
    summary: "Rotate or flip a photo's original bytes",
    description:
      'Applies a rotate/flip transform to the photo original, overwriting the ' +
      'stored file, regenerating its thumbnail, and re-enqueuing face detection. ' +
      'Photos only — returns 400 for videos or non-image media. Requires ' +
      'media:write and a per-circle collaborator role.',
  })
  @ApiParam({ name: 'id', description: 'Media item ID' })
  @ApiResponse({
    status: 201,
    description: '{ data: { status: "ready" | "failed", width, height } }',
  })
  @ApiResponse({ status: 400, description: 'Not a photo, or invalid op value' })
  @ApiResponse({ status: 403, description: 'Collaborator role required' })
  @ApiResponse({ status: 404, description: 'Media item not found' })
  async editOrientation(
    @Param('id') mediaItemId: string,
    @Body() dto: OrientationEditDto,
    @MemoriahubCurrentUser() user: MemoriahubRequestUser,
  ): Promise<{ data: { status: string; width: number; height: number } }> {
    const result = await this.orientationEditService.editOrientation(
      mediaItemId,
      dto.op,
      user,
    );
    return { data: result };
  }
}

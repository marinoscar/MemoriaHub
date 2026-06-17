// =============================================================================
// PeopleController
// =============================================================================

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PeopleService } from './people.service';
import {
  ListPeopleQueryDto,
  CreatePersonDto,
  UpdatePersonDto,
  AssignFacesDto,
  ClusterDto,
} from './dto/people.dto';

@ApiTags('People')
@ApiBearerAuth('JWT-auth')
@Controller('people')
export class PeopleController {
  constructor(private readonly peopleService: PeopleService) {}

  // NOTE: POST /api/people/cluster MUST be declared BEFORE GET /api/people/:id
  // to avoid route shadowing in Fastify (literal segment beats param segment
  // only when declared first in the class).

  /**
   * POST /api/people/cluster
   * Trigger clustering of unknown faces into provisional Person records.
   * Requires circle_admin role in the target circle.
   */
  @Post('cluster')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cluster unknown faces into provisional Person records (circle_admin)',
    description:
      'Runs greedy union-find clustering over all unassigned faces in the circle. ' +
      'Clusters meeting FACE_CLUSTER_MIN_SIZE create provisional Person records. ' +
      'Singletons remain unassigned. Requires circle_admin role.',
  })
  @ApiResponse({ status: 200, description: 'Clustering result returned' })
  @ApiResponse({ status: 403, description: 'Access denied (circle_admin required)' })
  async clusterUnknowns(
    @Body() dto: ClusterDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.peopleService.clusterUnknowns(
      dto.circleId,
      user.id,
      user.permissions,
    );
  }

  /**
   * GET /api/people
   * List Person records in a circle (paginated).
   */
  @Get()
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List people in a circle (paginated)' })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'includeUnlabeled', required: false, type: Boolean, description: 'Include unlabeled (name=null) people' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated people list' })
  async listPeople(
    @Query() query: ListPeopleQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.peopleService.listPeople(query, user.id, user.permissions);
  }

  /**
   * GET /api/people/:id
   * Get a Person with their associated faces.
   */
  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'Get a person with associated faces' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Person returned' })
  @ApiResponse({ status: 404, description: 'Person not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async getPerson(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.peopleService.getPerson(id, user.id, user.permissions);
  }

  /**
   * POST /api/people
   * Create a new Person (optionally with initial faces).
   */
  @Post()
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Create a new person (collaborator+)' })
  @ApiResponse({ status: 201, description: 'Person created' })
  @ApiResponse({ status: 403, description: 'Access denied (collaborator required)' })
  async createPerson(
    @Body() dto: CreatePersonDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.peopleService.createPerson(dto, user.id, user.permissions);
  }

  /**
   * PATCH /api/people/:id
   * Rename or set coverFaceId for a Person.
   */
  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @ApiOperation({ summary: 'Update person name or cover face (collaborator+)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Person updated' })
  @ApiResponse({ status: 404, description: 'Person not found' })
  @ApiResponse({ status: 403, description: 'Access denied (collaborator required)' })
  async updatePerson(
    @Param('id') id: string,
    @Body() dto: UpdatePersonDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.peopleService.updatePerson(id, dto, user.id, user.permissions);
  }

  /**
   * POST /api/people/:id/faces
   * Assign faces to a Person (manually).
   */
  @Post(':id/faces')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign faces to a person (collaborator+)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Faces assigned' })
  @ApiResponse({ status: 404, description: 'Person or face not found' })
  @ApiResponse({ status: 403, description: 'Access denied (collaborator required)' })
  async assignFaces(
    @Param('id') id: string,
    @Body() dto: AssignFacesDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.peopleService.assignFaces(id, dto, user.id, user.permissions);
  }

  /**
   * DELETE /api/people/:id/faces/:faceId
   * Unassign a face from a Person.
   */
  @Delete(':id/faces/:faceId')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unassign a face from a person (collaborator+)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'Person ID' })
  @ApiParam({ name: 'faceId', type: String, format: 'uuid', description: 'Face ID' })
  @ApiResponse({ status: 204, description: 'Face unassigned' })
  @ApiResponse({ status: 404, description: 'Person or face not found' })
  @ApiResponse({ status: 403, description: 'Access denied (collaborator required)' })
  async unassignFace(
    @Param('id') id: string,
    @Param('faceId') faceId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.peopleService.unassignFace(id, faceId, user.id, user.permissions);
  }
}

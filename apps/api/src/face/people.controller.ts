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
  ListUnassignedFacesQueryDto,
} from './dto/people.dto';
import { MergePeopleDto } from './dto/merge-people.dto';

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
   * POST /api/people/merge
   * Merge source person into target. All faces reassigned to target.
   * Source is soft-deleted with mergedIntoId set for audit.
   */
  @Post('merge')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Merge two people into one (collaborator+)',
    description:
      'Reassigns all faces from sourceId to targetId, soft-deletes source, recomputes target centroid.',
  })
  @ApiResponse({ status: 200, description: 'Merged; returns updated target person' })
  @ApiResponse({ status: 400, description: 'Invalid merge request (same circle required, must differ)' })
  @ApiResponse({ status: 404, description: 'Source or target person not found' })
  @ApiResponse({ status: 403, description: 'Access denied (collaborator required)' })
  async mergePeople(
    @Body() dto: MergePeopleDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.peopleService.mergePeople(dto, user.id, user.permissions);
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
   * GET /api/people/unassigned
   * List unassigned (personId=null) faces for a circle (paginated).
   * NOTE: Must be declared BEFORE GET :id to prevent Fastify treating "unassigned" as a param.
   */
  @Get('unassigned')
  @Auth({ permissions: [PERMISSIONS.MEDIA_READ] })
  @ApiOperation({ summary: 'List unassigned (personId=null) faces in a circle (paginated)' })
  @ApiQuery({ name: 'circleId', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated list of unassigned faces' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async listUnassignedFaces(
    @Query() query: ListUnassignedFacesQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.peopleService.listUnassignedFaces(user.id, user.permissions, query);
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
   * NOTE: Declared before DELETE :id to avoid Fastify route shadowing.
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

  /**
   * DELETE /api/people/:id
   * Soft-delete a Person; release faces back to unknown pool.
   */
  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.MEDIA_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a person (collaborator+)',
    description:
      'Soft-deletes the person and returns all associated faces to the unknown pool ' +
      '(personId=null, manuallyAssigned=false). Face rows and embeddings are retained.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Person deleted; faces returned to unknown pool' })
  @ApiResponse({ status: 404, description: 'Person not found' })
  @ApiResponse({ status: 403, description: 'Access denied (collaborator required)' })
  async deletePerson(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    await this.peopleService.deletePerson(id, user.id, user.permissions);
  }
}

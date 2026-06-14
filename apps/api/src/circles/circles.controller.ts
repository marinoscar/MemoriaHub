import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';

import { CirclesService } from './circles.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateCircleDto } from './dto/create-circle.dto';
import { UpdateCircleDto } from './dto/update-circle.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { CreateInviteDto } from './dto/create-invite.dto';
import { CirclesQueryDto } from './dto/circles-query.dto';

@ApiTags('Circles')
@ApiBearerAuth('JWT-auth')
@Controller('circles')
export class CirclesController {
  constructor(private readonly circlesService: CirclesService) {}

  // ----- Circles -----

  @Post()
  @Auth({ permissions: [PERMISSIONS.CIRCLES_WRITE] })
  @ApiOperation({ summary: 'Create a new circle' })
  @ApiResponse({ status: 201, description: 'Circle created' })
  async create(
    @Body() dto: CreateCircleDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.circlesService.create(userId, dto);
  }

  @Get()
  @Auth({ permissions: [PERMISSIONS.CIRCLES_READ] })
  @ApiOperation({ summary: 'List circles (member circles; ?all=true for super-admin)' })
  @ApiQuery({ name: 'all', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Paginated list of circles ({ items, total, page, pageSize, totalPages })' })
  async list(
    @Query() query: CirclesQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.circlesService.list(user, query.all);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.CIRCLES_READ] })
  @ApiOperation({ summary: 'Get circle by ID' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Circle details' })
  @ApiResponse({ status: 403, description: 'Not a member' })
  @ApiResponse({ status: 404, description: 'Circle not found' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.circlesService.getById(user, id);
  }

  @Patch(':id')
  @Auth({ permissions: [PERMISSIONS.CIRCLES_WRITE] })
  @ApiOperation({ summary: 'Update circle (circle_admin or super-admin)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Circle updated' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCircleDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.circlesService.update(user, id, dto);
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.CIRCLES_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete circle (circle_admin or super-admin; not personal circles)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Circle deleted' })
  @ApiResponse({ status: 400, description: 'Cannot delete personal circle' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.circlesService.remove(user, id);
  }

  // ----- Members -----

  @Get(':id/members')
  @Auth({ permissions: [PERMISSIONS.CIRCLES_READ] })
  @ApiOperation({ summary: 'List circle members' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Member list envelope ({ items, total })' })
  async listMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.circlesService.listMembers(user, id);
  }

  @Post(':id/members')
  @Auth({ permissions: [PERMISSIONS.CIRCLES_WRITE] })
  @ApiOperation({ summary: 'Add member to circle (circle_admin or super-admin)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Member added' })
  async addMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddMemberDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.circlesService.addMember(user, id, dto);
  }

  @Patch(':id/members/:userId')
  @Auth({ permissions: [PERMISSIONS.CIRCLES_WRITE] })
  @ApiOperation({ summary: 'Update member role (circle_admin or super-admin)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'userId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Member role updated' })
  @ApiResponse({ status: 400, description: 'Cannot demote last circle admin' })
  async updateMemberRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @Body() dto: UpdateMemberRoleDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.circlesService.updateMemberRole(user, id, targetUserId, dto);
  }

  @Delete(':id/members/:userId')
  @Auth({ permissions: [PERMISSIONS.CIRCLES_READ] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove member or self-leave circle' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'userId', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Member removed' })
  @ApiResponse({ status: 400, description: 'Cannot remove last circle admin' })
  async removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.circlesService.removeMember(user, id, targetUserId);
  }

  // ----- Invites -----

  @Get(':id/invites')
  @Auth({ permissions: [PERMISSIONS.CIRCLES_READ] })
  @ApiOperation({ summary: 'List circle invites (circle_admin or super-admin)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Invite list envelope ({ items, total })' })
  async listInvites(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.circlesService.listInvites(user, id);
  }

  @Post(':id/invites')
  @Auth({ permissions: [PERMISSIONS.CIRCLES_WRITE] })
  @ApiOperation({ summary: 'Create invite and upsert allowlist entry (circle_admin or super-admin)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Invite created' })
  async createInvite(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateInviteDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.circlesService.createInvite(user, id, dto);
  }

  @Delete(':id/invites/:inviteId')
  @Auth({ permissions: [PERMISSIONS.CIRCLES_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a pending invite (circle_admin or super-admin)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'inviteId', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Invite revoked' })
  @ApiResponse({ status: 400, description: 'Cannot revoke a claimed invite' })
  @ApiResponse({ status: 404, description: 'Invite not found' })
  async revokeInvite(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.circlesService.revokeInvite(user, id, inviteId);
  }
}

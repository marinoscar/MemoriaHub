import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { LocationGroupsService } from './location-groups.service';
import {
  CreateLocationGroupDto,
  ListLocationGroupSuggestionsDto,
  ListLocationGroupsDto,
  ListLocationValuesDto,
  LocationGroupMembersDto,
  MergeLocationGroupsDto,
  UpdateLocationGroupDto,
} from './dto/location-group.dto';

/**
 * LocationGroupsController — `/api/location-groups/*` (issue #374).
 *
 * RBAC: **no new permission.** Location groups reuse the Admin-only
 * `geo_settings:read` / `geo_settings:write` pair, because a group is a global
 * geo configuration exactly like the active reverse-geocoding provider — the
 * same reasoning that put `geo.reverseProvider` behind that pair. Non-admins
 * are unaffected: they see canonical names on every browse surface but cannot
 * manage groups.
 *
 * ROUTE ORDER MATTERS: `/values` and `/suggestions` are declared BEFORE
 * `/:id`, or Nest would match them as a group id and `ParseUUIDPipe` would
 * turn a perfectly valid request into a 400. `/merge` is kept with them for
 * the same reason — it is a static path today only because no `POST /:id`
 * handler exists, and adding one later must not silently swallow it.
 */
@ApiTags('Location Groups')
@Controller('location-groups')
export class LocationGroupsController {
  constructor(private readonly service: LocationGroupsService) {}

  @Get()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_READ] })
  @ApiOperation({
    summary: 'List location groups (Admin)',
    description:
      'Paginated group list. `itemCount` is live, derived from one groupBy over the canonical column per level — never a per-row lookup.',
  })
  @ApiResponse({ status: 200, description: '{ items, meta }' })
  async list(@Query() query: ListLocationGroupsDto) {
    return this.service.list(query);
  }

  @Get('values')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_READ] })
  @ApiOperation({
    summary: 'List distinct raw location values app-wide (Admin)',
    description:
      "The member picker's data source: every distinct RAW geocoder value at a tier, with the group that already owns it. Groups are global, so this is deliberately not circle-scoped.",
  })
  @ApiResponse({ status: 200, description: '{ items, meta }' })
  async listValues(@Query() query: ListLocationValuesDto) {
    return this.service.listValues(query);
  }

  @Get('suggestions')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Suggest location groups from ungrouped raw values (Admin)',
    description:
      'Clusters of two or more ungrouped raw values sharing a suggestionKey (fold + level-aware administrative-noise stripping). Values below locationGrouping.suggestionMinItems are excluded.',
  })
  @ApiResponse({ status: 200, description: '{ items, meta }' })
  async suggestions(@Query() query: ListLocationGroupSuggestionsDto) {
    return this.service.suggestions(query);
  }

  @Post('merge')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Merge many raw location values into one group (Admin)',
    description:
      'Select-many-and-merge (issue #407). Supply EXACTLY ONE of canonicalName (create a new group owning the values) or targetGroupId (add them to an existing group, never renaming it) — both or neither is a 400. One transaction, one enqueued rebuild. 409 (with the owner at details.groupId / details.groupName) when a value is already claimed by a different group; values the target already owns are counted in `skipped` instead.',
  })
  @ApiResponse({
    status: 201,
    description: '{ groupId, created, added, skipped, jobId, status, group }',
  })
  @ApiResponse({ status: 400, description: 'Both or neither target supplied, or a scope mismatch' })
  @ApiResponse({ status: 404, description: 'targetGroupId not found' })
  @ApiResponse({ status: 409, description: 'A value is already claimed by another group' })
  async merge(@Body() dto: MergeLocationGroupsDto, @CurrentUser('id') userId: string) {
    return this.service.merge(dto, userId ?? null);
  }

  @Get(':id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_READ] })
  @ApiOperation({ summary: 'Get a location group with its full alias list (Admin)' })
  @ApiParam({ name: 'id', description: 'Location group UUID' })
  @ApiResponse({ status: 200, description: 'Group detail' })
  @ApiResponse({ status: 404, description: 'Group not found' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Create a location group (Admin)',
    description:
      'Invalidates the resolver cache and enqueues a rebuild. 409 (with the owner at details.groupId / details.groupName) when a member value is already claimed by another group.',
  })
  @ApiResponse({ status: 201, description: 'Group created' })
  @ApiResponse({ status: 400, description: 'Invalid geometry or cover item' })
  @ApiResponse({ status: 409, description: 'Member value already claimed' })
  async create(
    @Body() dto: CreateLocationGroupDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.create(dto, userId ?? null);
  }

  @Patch(':id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Update a location group (Admin)' })
  @ApiParam({ name: 'id', description: 'Location group UUID' })
  @ApiResponse({ status: 200, description: 'Group updated' })
  @ApiResponse({ status: 400, description: 'Invalid geometry or cover item' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLocationGroupDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Delete a location group (Admin)',
    description:
      'Cascades its aliases and enqueues a rebuild, so members revert to their raw geocoder names.',
  })
  @ApiParam({ name: 'id', description: 'Location group UUID' })
  @ApiResponse({ status: 204, description: 'Group deleted' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.service.remove(id);
  }

  @Post(':id/members')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Add raw values to a location group (Admin)' })
  @ApiParam({ name: 'id', description: 'Location group UUID' })
  @ApiResponse({ status: 201, description: '{ added }' })
  @ApiResponse({ status: 409, description: 'Member value already claimed' })
  async addMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LocationGroupMembersDto,
  ) {
    return this.service.addMembers(id, dto.values);
  }

  @Delete(':id/members')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({ summary: 'Remove raw values from a location group (Admin)' })
  @ApiParam({ name: 'id', description: 'Location group UUID' })
  @ApiResponse({ status: 200, description: '{ removed }' })
  async removeMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LocationGroupMembersDto,
  ) {
    return this.service.removeMembers(id, dto.values);
  }
}

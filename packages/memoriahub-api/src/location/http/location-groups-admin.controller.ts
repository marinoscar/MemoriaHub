import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { MemoriahubAuth } from '../../core/index.js';
import { LocationGroupsService } from '../groups/location-groups.service.js';
import { RebuildLocationGroupsDto } from './location-group.dto.js';
import { LOCATION_PERMISSIONS as PERMISSIONS, LOCATION_ROLES as ROLES } from './location-permissions.js';

/**
 * LocationGroupsAdminController — `/api/admin/location-groups/*` (issue #374).
 *
 * Split from `LocationGroupsController` only because the route prefix differs;
 * both reuse the same Admin-only `geo_settings:*` pair (no new permission).
 */
/**
 * The `LocationGroupsAdminController` routes (`/api/admin/location-groups/*`); mounted by the host in its own
 * module.
 *
 * @stability experimental
 */
@ApiTags('Admin: Location Groups')
@Controller('admin/location-groups')
export class LocationGroupsAdminController {
  constructor(private readonly service: LocationGroupsService) {}

  @Post('rebuild')
  @MemoriahubAuth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.GEO_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Re-derive media_items.geo_canonical_* from the current groups (Admin)',
    description:
      'Enqueues the `location_group_rebuild` job. Every group mutation already enqueues a full rebuild automatically; this endpoint exists for an explicit re-run (e.g. after a bulk geocode backfill). Passing `groupIds` restricts only the alias/radius passes — the RESET pass always runs over the full scope, so a partial list leaves every other group reverted to raw names until the next full rebuild.',
  })
  @ApiResponse({ status: 201, description: '{ data: { jobId, status } }' })
  async rebuild(@Body() dto: RebuildLocationGroupsDto) {
    return this.service.triggerRebuild({
      circleId: dto.circleId,
      groupIds: dto.groupIds,
    });
  }
}

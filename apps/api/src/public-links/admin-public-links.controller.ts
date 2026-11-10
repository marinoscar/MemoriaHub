// =============================================================================
// GET /api/admin/links: every public link of the organization (RETRO-I4, #578)
// =============================================================================
//
// Backs `/admin/settings/sharing` (it listed `/api/shares?scope=all` behind
// `shares:manage_any`; now `sharing:admin`, the sharing slice's org-wide
// override). Read-only: revoking and re-dating a link go through the slice's
// `DELETE` / `PATCH /api/grants/:id` (a `sharing:admin` holder may: the media
// resource types map `share_link` to `sharing:admin` in `bypassPermissions`).
// The old bulk hard-delete is gone (open decision 2): the slice revokes, and its
// `sharing.grants.prune` job deletes revoked and expired grants after the
// retention window.
// =============================================================================

import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '@marinoscar/platform-api/core';
import { Auth, CurrentPrincipal } from '@marinoscar/platform-api/identity';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { PERMISSIONS } from '../common/constants/roles.constants';
import { AdminPublicLinksService, type AdminPublicLinkPage } from './admin-public-links.service';

export const adminLinksQuerySchema = z.object({
  status: z.enum(['active', 'expired', 'revoked']).optional(),
  resourceType: z.enum(['media_item', 'album']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export class AdminLinksQueryDto extends createZodDto(adminLinksQuerySchema) {}

@ApiTags('Public Sharing')
@Controller('admin/links')
export class AdminPublicLinksController {
  constructor(private readonly links: AdminPublicLinksService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SHARING_ADMIN] })
  @ApiOperation({
    summary: 'List every public link (admin)',
    description:
      'Link grants on photos, videos and albums across the organization, newest first, each with its status, ' +
      'its shareable URL, its creator and a preview. Revoke with `DELETE /api/grants/:id`, re-date with ' +
      '`PATCH /api/grants/:id`.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'expired', 'revoked'] })
  @ApiQuery({ name: 'resourceType', required: false, enum: ['media_item', 'album'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'A page of links' })
  list(@CurrentPrincipal() principal: Principal, @Query() query: AdminLinksQueryDto): Promise<AdminPublicLinkPage> {
    return this.links.list(principal, query);
  }
}

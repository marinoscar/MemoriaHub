// =============================================================================
// Nodes Admin Controller
// =============================================================================
//
// Admin-only management of all worker nodes across the fleet. Mounted at
// /api/admin/nodes.
// =============================================================================

import {
  Controller,
  Get,
  Delete,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { NodesService } from './nodes.service';
import { NodeCredentialService } from './node-credential.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';
import { AdminNodeCredentialListItemDto } from './dto/node-credential-response.dto';

@ApiTags('Admin - Nodes')
@Controller('admin/nodes')
export class NodesAdminController {
  constructor(
    private readonly nodesService: NodesService,
    private readonly nodeCredentialService: NodeCredentialService,
  ) {}

  // -------------------------------------------------------------------------
  // GET /admin/nodes
  // -------------------------------------------------------------------------

  @Get()
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_READ] })
  @ApiOperation({
    summary: 'List all worker nodes with health and job counts (Admin)',
    description:
      'Returns every registered worker node, each annotated with a derived health ' +
      'status (healthy/stale/offline based on heartbeat freshness and status) and ' +
      'per-node claimed-job counts by status.',
  })
  @ApiResponse({ status: 200, description: 'Nodes with health and jobCounts' })
  async listNodes() {
    return this.nodesService.listNodes();
  }

  // -------------------------------------------------------------------------
  // GET /admin/nodes/credentials
  //
  // NOTE: the literal 'credentials' routes are declared BEFORE the ':id' param
  // route below — NestJS registers routes in declaration order, so this keeps
  // 'credentials' from being captured as an :id value.
  // -------------------------------------------------------------------------

  @Get('credentials')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_READ] })
  @ApiOperation({
    summary: 'List all worker-node credentials across users (Admin)',
    description:
      'Returns every node credential with its owning user email/display name. ' +
      'Raw tokens and hashes are never returned.',
  })
  @ApiResponse({
    status: 200,
    description: 'All node credentials with owner info',
    type: [AdminNodeCredentialListItemDto],
  })
  async listCredentials(): Promise<AdminNodeCredentialListItemDto[]> {
    const credentials = await this.nodeCredentialService.listAll();
    return credentials.map((c) => ({
      id: c.id,
      userId: c.userId,
      name: c.name,
      tokenPrefix: c.tokenPrefix,
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      lastUsedAt: c.lastUsedAt ? c.lastUsedAt.toISOString() : null,
      createdAt: c.createdAt.toISOString(),
      revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
      ownerEmail: c.ownerEmail,
      ownerDisplayName: c.ownerDisplayName,
    }));
  }

  // -------------------------------------------------------------------------
  // DELETE /admin/nodes/credentials/:id
  // -------------------------------------------------------------------------

  @Delete('credentials/:id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke any worker-node credential regardless of owner (Admin)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Credential revoked' })
  @ApiResponse({ status: 404, description: 'Credential not found or already revoked' })
  async revokeCredential(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.nodeCredentialService.revokeAny(id);
  }

  // -------------------------------------------------------------------------
  // DELETE /admin/nodes/:id
  // -------------------------------------------------------------------------

  @Delete(':id')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({ summary: 'Delete a worker node row (Admin)' })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiResponse({ status: 200, description: 'Node deleted' })
  async deleteNode(@Param('id') id: string) {
    return this.nodesService.deleteNode(id);
  }
}

// =============================================================================
// Nodes Admin Controller
// =============================================================================
//
// Admin-only management of all worker nodes across the fleet. Mounted at
// /api/admin/nodes.
// =============================================================================

import { Controller, Get, Delete, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { NodesService } from './nodes.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';

@ApiTags('Admin - Nodes')
@Controller('admin/nodes')
export class NodesAdminController {
  constructor(private readonly nodesService: NodesService) {}

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

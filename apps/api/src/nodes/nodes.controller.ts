// =============================================================================
// Nodes Controller
// =============================================================================
//
// Data-plane control API for distributed worker nodes. Nodes register, send
// heartbeats, atomically claim enrichment jobs, renew leases while working, and
// download the parity model manifest. Mounted at /api/nodes.
//
// Every route requires jobs:write (the manifest GET requires only jobs:read).
// Owner-scoping (a caller may only touch nodes they registered) is enforced in
// NodesService.
// =============================================================================

import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { NodeStatus } from '@prisma/client';
import { NodesService } from './nodes.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../common/constants/roles.constants';

// ---------------------------------------------------------------------------
// DTOs (Zod — matches project convention)
// ---------------------------------------------------------------------------

const registerNodeSchema = z.object({
  name: z.string().min(1),
  hostname: z.string().min(1),
  platform: z.string().min(1),
  cliVersion: z.string().min(1),
  eligibleTypes: z.array(z.string().min(1)),
  concurrency: z.number().int().min(1).default(1),
});

export class RegisterNodeDto extends createZodDto(registerNodeSchema) {}

const heartbeatSchema = z.object({
  status: z
    .enum([
      NodeStatus.online,
      NodeStatus.draining,
      NodeStatus.offline,
      NodeStatus.disabled,
    ])
    .optional(),
  // Arbitrary `node doctor` capability summary JSON.
  capabilities: z.any().optional(),
  // Accepted for forward-compat (current in-flight job count); service ignores it.
  inFlight: z.number().int().min(0).optional(),
});

export class HeartbeatDto extends createZodDto(heartbeatSchema) {}

const claimSchema = z.object({
  max: z.number().int().min(1).optional(),
  types: z.array(z.string().min(1)).optional(),
});

export class ClaimDto extends createZodDto(claimSchema) {}

const renewLeaseSchema = z.object({
  leaseMs: z.number().int().min(1000).optional(),
});

export class RenewLeaseDto extends createZodDto(renewLeaseSchema) {}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('Nodes')
@Controller('nodes')
export class NodesController {
  constructor(private readonly nodesService: NodesService) {}

  // -------------------------------------------------------------------------
  // POST /nodes/register
  // -------------------------------------------------------------------------

  @Post('register')
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({ summary: 'Register a worker node' })
  @ApiResponse({ status: 201, description: 'Node registered; returns { nodeId }' })
  async register(@CurrentUser() user: RequestUser, @Body() dto: RegisterNodeDto) {
    return this.nodesService.register(user.id, dto);
  }

  // -------------------------------------------------------------------------
  // POST /nodes/:id/deregister
  // -------------------------------------------------------------------------

  @Post(':id/deregister')
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({ summary: 'Deregister a worker node (marks it offline)' })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiResponse({ status: 201, description: 'Node marked offline' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node not found' })
  async deregister(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.nodesService.deregister(user.id, id);
  }

  // -------------------------------------------------------------------------
  // POST /nodes/:id/heartbeat
  // -------------------------------------------------------------------------

  @Post(':id/heartbeat')
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({ summary: 'Report a worker node heartbeat and optional status/capabilities' })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiResponse({ status: 201, description: 'Heartbeat recorded' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node not found' })
  async heartbeat(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: HeartbeatDto,
  ) {
    return this.nodesService.heartbeat(user.id, id, dto);
  }

  // -------------------------------------------------------------------------
  // POST /nodes/:id/claim
  // -------------------------------------------------------------------------

  @Post(':id/claim')
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({
    summary: 'Atomically claim eligible enrichment jobs for a worker node',
    description:
      'Claims up to the node concurrency (or the requested max, whichever is smaller) ' +
      'eligible pending jobs and marks them running under this node with a lease. ' +
      'Each returned job includes a best-effort presigned input URL and its payload params.',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiResponse({ status: 201, description: 'Claimed jobs with input URLs and params' })
  @ApiResponse({ status: 403, description: 'Node disabled or caller does not own it' })
  @ApiResponse({ status: 404, description: 'Node not found' })
  async claim(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: ClaimDto,
  ) {
    return this.nodesService.claim(user.id, id, dto.max, dto.types);
  }

  // -------------------------------------------------------------------------
  // POST /nodes/:id/jobs/:jobId/renew
  // -------------------------------------------------------------------------

  @Post(':id/jobs/:jobId/renew')
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({ summary: 'Renew the lease on a running job claimed by this node' })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiParam({ name: 'jobId', description: 'Enrichment job UUID' })
  @ApiResponse({ status: 201, description: 'Lease extended; returns { leaseExpiresAt }' })
  @ApiResponse({ status: 400, description: 'Job not owned by this node or not running' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node not found' })
  async renewLease(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Body() dto: RenewLeaseDto,
  ) {
    return this.nodesService.renewLease(user.id, id, jobId, dto.leaseMs);
  }

  // -------------------------------------------------------------------------
  // GET /nodes/models/manifest
  // -------------------------------------------------------------------------

  @Get('models/manifest')
  @Auth({ permissions: [PERMISSIONS.JOBS_READ] })
  @ApiOperation({ summary: 'Get the parity model manifest worker nodes must download' })
  @ApiResponse({ status: 200, description: 'Static list of parity models with download URLs' })
  async getModelManifest() {
    return this.nodesService.getModelManifest();
  }
}

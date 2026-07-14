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
import { SubmitJobResultDto, ReportJobFailureDto } from './dto/compute-result.dto';
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
  // Live concurrency cap; persisted so the claim endpoint stops using the
  // stale registration-time value after a runtime `set-concurrency` change.
  concurrency: z.number().int().min(1).optional(),
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
  // POST /nodes/:id/jobs/:jobId/upload-url
  // -------------------------------------------------------------------------

  @Post(':id/jobs/:jobId/upload-url')
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({
    summary: 'Get a presigned upload URL for a claimed job to PUT output bytes to',
    description:
      'Currently used by the thumbnail node-compute path: the node computes a JPEG locally, ' +
      'calls this endpoint to learn where to PUT it (the server chooses the storage key — ' +
      'never the node), uploads directly to the returned presigned URL, then submits ' +
      '{ storageKey, width, height, bytes } via POST /nodes/:id/jobs/:jobId/result. ' +
      'Reuses the same held-job guard as the result/failure endpoints.',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiParam({ name: 'jobId', description: 'Enrichment job UUID' })
  @ApiResponse({
    status: 201,
    description: 'Presigned upload URL — { url, storageKey, expiresSeconds }',
  })
  @ApiResponse({ status: 400, description: 'Job has no mediaItemId or linked StorageObject' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node or job not found' })
  @ApiResponse({
    status: 409,
    description: 'Job not held by this node (not claimed by it, not running, or lease expired)',
  })
  async getJobUploadUrl(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ) {
    return this.nodesService.getJobUploadUrl(user.id, id, jobId);
  }

  // -------------------------------------------------------------------------
  // POST /nodes/:id/jobs/:jobId/credentials
  // -------------------------------------------------------------------------

  @Post(':id/jobs/:jobId/credentials')
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({
    summary: 'Get transient, per-job provider credentials for auto_tagging or geocode',
    description:
      'Resolves a plaintext provider API key scoped to THIS job only (mandated alternative to ' +
      'the "AI-proxy" pattern in docs/specs/distributed-nodes.md, which is stale on this point) ' +
      'so the node can call the provider\'s HTTP API directly. The node MUST hold the key only ' +
      'in memory for the duration of the compute call and MUST NEVER persist it to disk, ' +
      'config, or logs. Reuses the same held-job guard as the result/failure endpoints.',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiParam({ name: 'jobId', description: 'Enrichment job UUID' })
  @ApiResponse({
    status: 201,
    description:
      'Transient job credentials — shape depends on job type (auto_tagging: ' +
      '{ type, provider, model, apiKey, baseUrl?, system, prompt, mimeTypeHint }; geocode: ' +
      '{ type, provider, apiKey?, baseUrl?, lat, lng })',
  })
  @ApiResponse({
    status: 400,
    description:
      'Job type has no credentials contract, job/media item missing required data, or provider ' +
      'not configured',
  })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node or job not found' })
  @ApiResponse({
    status: 409,
    description: 'Job not held by this node (not claimed by it, not running, or lease expired)',
  })
  async getJobCredentials(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ) {
    return this.nodesService.getJobCredentials(user.id, id, jobId);
  }

  // -------------------------------------------------------------------------
  // POST /nodes/:id/jobs/:jobId/result
  // -------------------------------------------------------------------------

  @Post(':id/jobs/:jobId/result')
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({
    summary: 'Submit a node-computed result for a claimed job',
    description:
      'Validates the payload against the job type\'s node-result schema, persists it via the ' +
      'handler\'s persist-only path, and completes the job as succeeded (same terminal ' +
      'semantics as the in-process worker). The job must still be held by this node under a ' +
      'live lease — late results after lease expiry/re-claim are rejected with 409.',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiParam({ name: 'jobId', description: 'Enrichment job UUID' })
  @ApiResponse({ status: 201, description: 'Result persisted; job succeeded — { ok: true }' })
  @ApiResponse({
    status: 400,
    description: 'Type mismatch, job type not node-persistable, or invalid result payload',
  })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node or job not found' })
  @ApiResponse({
    status: 409,
    description: 'Job not held by this node (not claimed by it, not running, or lease expired)',
  })
  @ApiResponse({
    status: 500,
    description: 'Persist failed; job routed through the failure/retry path — do not resubmit',
  })
  async submitJobResult(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Body() dto: SubmitJobResultDto,
  ) {
    return this.nodesService.submitJobResult(user.id, id, jobId, dto);
  }

  // -------------------------------------------------------------------------
  // POST /nodes/:id/jobs/:jobId/failure
  // -------------------------------------------------------------------------

  @Post(':id/jobs/:jobId/failure')
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({
    summary: 'Report a node-side failure for a claimed job',
    description:
      'Routes the job through the shared terminal failure state machine: rateLimited reports ' +
      'enter the deferral path (and trip the shared provider-throttle gate); everything else ' +
      'enters the exponential-retry path. willRetry is advisory only — the server\'s attempts ' +
      'budget decides whether the job is requeued or permanently failed.',
  })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiParam({ name: 'jobId', description: 'Enrichment job UUID' })
  @ApiResponse({ status: 201, description: 'Failure recorded — { ok: true }' })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node or job not found' })
  @ApiResponse({
    status: 409,
    description: 'Job not held by this node (not claimed by it, not running, or lease expired)',
  })
  async reportJobFailure(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Body() dto: ReportJobFailureDto,
  ) {
    return this.nodesService.reportJobFailure(user.id, id, jobId, dto);
  }

  // -------------------------------------------------------------------------
  // GET /nodes
  // -------------------------------------------------------------------------
  //
  // Placement note: a single-segment `@Get(':id')` route below can never
  // accidentally intercept the two-segment `@Get('models/manifest')` route
  // (NestJS/Express match by path-segment count as well as literal-vs-param,
  // and `/nodes/models/manifest` has 2 segments after `/nodes`, so it can
  // only match a 2-segment route pattern). Route declaration order therefore
  // doesn't actually matter here — but we still place the literal route
  // before the param route as the safe, idiomatic convention.

  @Get()
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({ summary: 'List worker nodes owned by the caller' })
  @ApiResponse({
    status: 200,
    description:
      'Bare array of owner-scoped node records, each with { ...node, health, jobCounts }',
  })
  async list(@CurrentUser() user: RequestUser) {
    return this.nodesService.listNodes(user.id);
  }

  // -------------------------------------------------------------------------
  // GET /nodes/:id
  // -------------------------------------------------------------------------

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({ summary: 'Get a single worker node owned by the caller' })
  @ApiParam({ name: 'id', description: 'Worker node UUID' })
  @ApiResponse({
    status: 200,
    description: 'Node record with { ...node, health, jobCounts }',
  })
  @ApiResponse({ status: 403, description: 'Caller does not own this node' })
  @ApiResponse({ status: 404, description: 'Node not found' })
  async getOne(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.nodesService.getNode(user.id, id);
  }

  // -------------------------------------------------------------------------
  // GET /nodes/models/manifest
  // -------------------------------------------------------------------------

  @Get('models/manifest')
  @Auth({ permissions: [PERMISSIONS.JOBS_READ] })
  @ApiOperation({ summary: 'Get the parity model manifest worker nodes must download' })
  @ApiResponse({
    status: 200,
    description:
      'Bare array of parity model entries ({ name, url, sha256, bytes, targetSubdir }) — the ' +
      'CLI unwraps the { data } envelope and iterates the array directly',
  })
  async getModelManifest() {
    return this.nodesService.getModelManifest();
  }
}

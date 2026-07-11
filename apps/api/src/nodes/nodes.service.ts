// =============================================================================
// Nodes Service
// =============================================================================
//
// Control-plane service for the distributed worker-node data plane. Handles node
// registration/lifecycle, heartbeats, atomic job claiming (delegated to the
// shared EnrichmentClaimService), lease renewal, admin listing with health, and
// the static parity model manifest that nodes download to match server output.
// =============================================================================

import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { EnrichmentJob, JobStatus, NodeStatus, WorkerNode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentClaimService } from '../enrichment/enrichment-claim.service';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { EnrichmentTerminalService } from '../enrichment/enrichment-terminal.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { ObjectsService } from '../storage/objects/objects.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { AiSettingsService } from '../ai/ai-settings.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { AutoTaggingService } from '../tagging/auto-tagging.service';
import { decryptSecret } from '../common/crypto/secret-cipher';
import type { JobCredentialsResult } from './dto/job-credentials.dto';

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface RegisterNodeInput {
  name: string;
  hostname: string;
  platform: string;
  cliVersion: string;
  eligibleTypes: string[];
  concurrency?: number;
}

export interface HeartbeatInput {
  status?: NodeStatus;
  capabilities?: unknown;
}

// ---------------------------------------------------------------------------
// Defaults resolved from env
// ---------------------------------------------------------------------------

/** Default lease duration (ms) for claimed jobs. */
function defaultLeaseMs(): number {
  return Number(process.env.ENRICHMENT_LEASE_MS) || 1_800_000;
}

/** Freshness window (ms) beyond which a heartbeat is considered stale. */
function staleWindowMs(): number {
  return (Number(process.env.NODE_HEARTBEAT_STALE_SECONDS) || 60) * 1000;
}

@Injectable()
export class NodesService {
  private readonly logger = new Logger(NodesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentClaimService: EnrichmentClaimService,
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly terminal: EnrichmentTerminalService,
    private readonly objectsService: ObjectsService,
    private readonly storageProviderResolver: StorageProviderResolver,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly aiSettingsService: AiSettingsService,
    private readonly systemSettings: SystemSettingsService,
    private readonly autoTaggingService: AutoTaggingService,
  ) {}

  // -------------------------------------------------------------------------
  // Ownership helper
  // -------------------------------------------------------------------------

  /**
   * Load a node and assert the caller owns it. Throws NotFoundException if the
   * node does not exist, ForbiddenException if it belongs to another user.
   * Every owner-scoped data-plane call funnels through this.
   */
  private async assertOwnership(userId: string, nodeId: string): Promise<WorkerNode> {
    const node = await this.prisma.workerNode.findUnique({ where: { id: nodeId } });
    if (!node) {
      throw new NotFoundException(`WorkerNode ${nodeId} not found`);
    }
    if (node.createdById !== userId) {
      throw new ForbiddenException('You do not own this worker node');
    }
    return node;
  }

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  async register(userId: string, dto: RegisterNodeInput): Promise<{ nodeId: string }> {
    const now = new Date();
    const node = await this.prisma.workerNode.create({
      data: {
        name: dto.name,
        hostname: dto.hostname,
        platform: dto.platform,
        cliVersion: dto.cliVersion,
        eligibleTypes: dto.eligibleTypes,
        concurrency: dto.concurrency ?? 1,
        status: NodeStatus.online,
        registeredAt: now,
        lastHeartbeatAt: now,
        createdById: userId,
      },
    });
    return { nodeId: node.id };
  }

  // -------------------------------------------------------------------------
  // deregister
  // -------------------------------------------------------------------------

  async deregister(userId: string, nodeId: string): Promise<{ status: NodeStatus }> {
    await this.assertOwnership(userId, nodeId);
    const updated = await this.prisma.workerNode.update({
      where: { id: nodeId },
      data: { status: NodeStatus.offline },
    });
    return { status: updated.status };
  }

  // -------------------------------------------------------------------------
  // heartbeat
  // -------------------------------------------------------------------------

  async heartbeat(
    userId: string,
    nodeId: string,
    dto: HeartbeatInput,
  ): Promise<{ ok: true }> {
    await this.assertOwnership(userId, nodeId);
    await this.prisma.workerNode.update({
      where: { id: nodeId },
      data: {
        lastHeartbeatAt: new Date(),
        // Only overwrite status/capabilities when the node actually reported them.
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.capabilities !== undefined
          ? { capabilities: dto.capabilities as never }
          : {}),
      },
    });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // claim
  // -------------------------------------------------------------------------

  async claim(
    userId: string,
    nodeId: string,
    max?: number,
    types?: string[],
  ): Promise<{ jobs: Array<{ job: EnrichmentJob; inputUrl: string | null; params: unknown }> }> {
    const node = await this.assertOwnership(userId, nodeId);

    if (node.status === NodeStatus.disabled) {
      throw new ForbiddenException('This worker node is disabled and cannot claim jobs');
    }

    // Intersect requested types with the node's eligible types when the caller
    // narrows the set; otherwise use the node's full eligible-types list.
    const eligibleTypes =
      types && types.length > 0
        ? node.eligibleTypes.filter((t) => types.includes(t))
        : node.eligibleTypes;

    // Never exceed the node's declared concurrency.
    const limit = Math.min(max ?? node.concurrency, node.concurrency);
    const leaseMs = defaultLeaseMs();

    const claimed = await this.enrichmentClaimService.claim({
      nodeId,
      executor: 'node',
      eligibleTypes,
      limit,
      leaseMs,
    });

    const jobs = await Promise.all(
      claimed.map(async (job) => ({
        job,
        inputUrl: await this.resolveInputUrl(job, userId, /* userPermissions */ []),
        params: job.payload ?? null,
      })),
    );

    return { jobs };
  }

  /**
   * Best-effort presigned download URL for a claimed job's source object.
   *
   * KNOWN LIMITATION: ObjectsService.getDownloadUrl performs a per-user
   * ownership/circle-membership auth check keyed to the node owner. A node
   * owner's PAT may not have access to every job's media (e.g. system/global
   * jobs, or media in circles the owner isn't a member of), in which case the
   * presign throws. We swallow any error and return null so a single
   * inaccessible object never fails the whole claim. A trusted node executor
   * should ideally bypass per-user auth here — deferred.
   */
  private async resolveInputUrl(
    job: EnrichmentJob,
    userId: string,
    userPermissions: string[],
  ): Promise<string | null> {
    // Global/system jobs have no media item — nothing to presign.
    if (!job.mediaItemId) {
      return null;
    }

    try {
      const mediaItem = await this.prisma.mediaItem.findUnique({
        where: { id: job.mediaItemId },
        select: { storageObjectId: true },
      });
      if (!mediaItem?.storageObjectId) {
        return null;
      }
      const result = await this.objectsService.getDownloadUrl(
        mediaItem.storageObjectId,
        userId,
        undefined,
        userPermissions,
      );
      return result.url;
    } catch {
      // Inaccessible / not-ready object — continue without an input URL.
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // renewLease
  // -------------------------------------------------------------------------

  async renewLease(
    userId: string,
    nodeId: string,
    jobId: string,
    leaseMs?: number,
  ): Promise<{ leaseExpiresAt: Date }> {
    await this.assertOwnership(userId, nodeId);

    const leaseExpiresAt = new Date(Date.now() + (leaseMs ?? defaultLeaseMs()));

    // Conditional update: only extend the lease when this node still holds the
    // running job. count === 0 means the job was reassigned, finished, or the
    // lease was reaped — the node should stop working it.
    const result = await this.prisma.enrichmentJob.updateMany({
      where: {
        id: jobId,
        status: JobStatus.running,
        claimedByNodeId: nodeId,
      },
      data: { leaseExpiresAt },
    });

    if (result.count === 0) {
      throw new BadRequestException('job not owned by this node or not running');
    }

    return { leaseExpiresAt };
  }

  // -------------------------------------------------------------------------
  // Result / failure ingestion
  // -------------------------------------------------------------------------

  /**
   * Assert that `nodeId` (owned by `userId`) currently HOLDS the running job
   * `jobId` under a live lease, and return the job row.
   *
   * 404 when the job does not exist; 409 (Conflict) when the job is not
   * claimed by this node, is no longer running, or its lease has expired.
   * The lease check is what rejects LATE results: once the lease-expiry reaper
   * has requeued (or another executor has re-claimed) the job, a straggler
   * node's result/failure report must not double-persist or clobber the newer
   * execution's state.
   */
  async assertJobHeldByNode(
    userId: string,
    nodeId: string,
    jobId: string,
  ): Promise<EnrichmentJob> {
    await this.assertOwnership(userId, nodeId);

    const job = await this.prisma.enrichmentJob.findUnique({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundException(`EnrichmentJob ${jobId} not found`);
    }

    if (
      job.claimedByNodeId !== nodeId ||
      job.status !== JobStatus.running ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= new Date()
    ) {
      throw new ConflictException(
        'job is not held by this node (not claimed by it, not running, or lease expired)',
      );
    }

    return job;
  }

  // -------------------------------------------------------------------------
  // getJobUploadUrl
  // -------------------------------------------------------------------------

  /**
   * Issue a presigned PUT URL for a claimed job to upload output bytes to —
   * currently used by the thumbnail node-compute path (`thumbnail_regen` /
   * `thumbnail_repair`): the node computes a JPEG locally, calls this
   * endpoint to learn WHERE to put it, PUTs the bytes directly to the
   * returned URL, then submits `{ storageKey, width, height, bytes }` via
   * `POST /nodes/:id/jobs/:jobId/result`.
   *
   * Reuses the same held-job guard as submitJobResult/reportJobFailure (404
   * unknown job, 409 if not held by this node under a live lease) so a
   * straggler node past lease expiry cannot obtain a fresh upload URL either.
   *
   * The SERVER chooses the storage key — never the node — using the exact
   * same convention as the in-process pipeline
   * (`ThumbnailProcessor.uploadThumbnail`): `thumbnails/<originalObjectId>.jpg`,
   * keyed off the target MediaItem's StorageObject id, so a node-produced
   * thumbnail is indistinguishable in storage layout from a server-produced
   * one.
   */
  async getJobUploadUrl(
    userId: string,
    nodeId: string,
    jobId: string,
  ): Promise<{ url: string; storageKey: string; expiresSeconds: number }> {
    const job = await this.assertJobHeldByNode(userId, nodeId, jobId);

    if (!job.mediaItemId) {
      throw new BadRequestException(
        `job ${jobId} has no mediaItemId — an upload URL cannot be derived for a global job`,
      );
    }

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: job.mediaItemId },
      select: { storageObjectId: true },
    });

    if (!mediaItem?.storageObjectId) {
      throw new BadRequestException(
        `MediaItem ${job.mediaItemId} for job ${jobId} has no linked StorageObject`,
      );
    }

    const storageKey = `thumbnails/${mediaItem.storageObjectId}.jpg`;
    const expiresSeconds = 3600;

    const { provider } = await this.storageProviderResolver.getActiveProvider();
    const url = await provider.getSignedPutUrl(storageKey, {
      contentType: 'image/jpeg',
      expiresIn: expiresSeconds,
    });

    return { url, storageKey, expiresSeconds };
  }

  // -------------------------------------------------------------------------
  // getJobCredentials
  // -------------------------------------------------------------------------

  /**
   * Resolve TRANSIENT, per-job provider credentials for a node-eligible job
   * (currently `auto_tagging` and `geocode`) — the mandated alternative to the
   * "AI-proxy" pattern documented (stale) in docs/specs/distributed-nodes.md:
   * the node fetches a plaintext provider API key scoped to THIS job only,
   * calls the provider's HTTP API directly, and never persists the key to
   * disk/config/logs. The response is never logged server-side either — no
   * interceptor in this app logs response bodies (LoggingInterceptor only
   * logs method/url/duration; Fastify's built-in request logger logs
   * standard req/res metadata with no custom body serializers).
   *
   * Reuses the same held-job guard as submitJobResult/reportJobFailure (404
   * unknown job, 409 if not held by this node under a live lease).
   */
  async getJobCredentials(
    userId: string,
    nodeId: string,
    jobId: string,
  ): Promise<JobCredentialsResult> {
    const job = await this.assertJobHeldByNode(userId, nodeId, jobId);

    if (job.type === 'auto_tagging') {
      return this.getAutoTaggingCredentials(job);
    }
    if (job.type === 'geocode') {
      return this.getGeocodeCredentials(job);
    }
    throw new BadRequestException(`credentials not applicable to job type "${job.type}"`);
  }

  private async getAutoTaggingCredentials(job: EnrichmentJob): Promise<JobCredentialsResult> {
    if (!job.mediaItemId) {
      throw new BadRequestException(`auto_tagging job ${job.id} has no mediaItemId`);
    }

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: job.mediaItemId },
      select: { id: true },
    });
    if (!mediaItem) {
      throw new BadRequestException(`MediaItem ${job.mediaItemId} not found`);
    }

    // Resolve provider/model exactly like AutoTaggingService.processMediaItem
    // does (step d) so a node and the server agree on which vision model runs.
    const row = await this.prisma.systemSettings.findUnique({ where: { key: 'global' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taggingConfig = (row?.value as any)?.ai?.features?.tagging as
      | { provider?: string; model?: string }
      | undefined;
    const provider = taggingConfig?.provider;
    const model = taggingConfig?.model;
    if (!provider || !model) {
      throw new BadRequestException('AI tagging provider or model not configured in system settings');
    }

    // Record on the job row so persistAutoTagging (called later via
    // persistNodeResult, after a fresh DB read in assertJobHeldByNode) knows
    // which provider/model produced the result.
    await this.enrichmentJobService.recordModel(job.id, provider, model);

    const creds = await this.aiSettingsService.resolveCredentials(provider);

    const tagLabels = await this.prisma.tagLabel.findMany({
      where: { enabled: true },
      select: { name: true },
      orderBy: { name: 'asc' },
    });
    const labelNames = tagLabels.map((t) => t.name);

    const faces = await this.prisma.face.findMany({
      where: {
        mediaItemId: job.mediaItemId,
        personId: { not: null },
        person: { deletedAt: null, mergedIntoId: null },
      },
      select: { person: { select: { name: true } } },
    });
    const peopleNames = [
      ...new Set(faces.map((f) => f.person?.name).filter((n): n is string => !!n)),
    ];

    const { system, prompt } = this.autoTaggingService.buildPrompt(labelNames, peopleNames);

    return {
      type: 'auto_tagging',
      provider,
      model,
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
      system,
      prompt,
      mimeTypeHint: 'image/jpeg',
    };
  }

  private async getGeocodeCredentials(job: EnrichmentJob): Promise<JobCredentialsResult> {
    if (!job.mediaItemId) {
      throw new BadRequestException(`geocode job ${job.id} has no mediaItemId`);
    }

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: job.mediaItemId },
      select: { takenLat: true, takenLng: true },
    });
    if (!mediaItem || !Number.isFinite(mediaItem.takenLat) || !Number.isFinite(mediaItem.takenLng)) {
      throw new BadRequestException(`MediaItem ${job.mediaItemId} has no usable GPS coordinates`);
    }
    const lat = mediaItem.takenLat as number;
    const lng = mediaItem.takenLng as number;

    // Resolve the active provider exactly like GeoLocationService.reverseGeocode does.
    const settings = await this.systemSettings.getSettings();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeProvider =
      ((settings as any).geo?.reverseProvider as string | undefined) ??
      process.env['GEO_PROVIDER'] ??
      'offline';

    if (activeProvider === 'google') {
      const cred = await this.prisma.geoProviderCredential.findUnique({ where: { provider: 'google' } });
      if (!cred || !cred.enabled) {
        // Mirrors GeoLocationService's own fallback-to-offline behavior when
        // google is configured active but the credential is missing/disabled.
        return { type: 'geocode', provider: 'offline', lat, lng };
      }
      const apiKey = decryptSecret(cred.encryptedKey);
      return { type: 'geocode', provider: 'google', apiKey, lat, lng };
    }

    if (activeProvider === 'nominatim') {
      return {
        type: 'geocode',
        provider: 'nominatim',
        baseUrl: process.env['NOMINATIM_BASE_URL'] ?? 'https://nominatim.openstreetmap.org',
        lat,
        lng,
      };
    }

    // default: offline — not node-eligible; the CLI declines with
    // CapabilityUnavailableError rather than attempting a lookup.
    return { type: 'geocode', provider: 'offline', lat, lng };
  }

  /**
   * Ingest a node-computed result for a claimed job: validate it against the
   * handler's nodeResultSchema, persist via the handler's persistNodeResult
   * (the persist half of the compute/persist split), then complete the job
   * through the shared terminal service (same succeeded semantics as the
   * in-process worker).
   */
  async submitJobResult(
    userId: string,
    nodeId: string,
    jobId: string,
    body: { type: string; result: unknown },
  ): Promise<{ ok: true }> {
    const job = await this.assertJobHeldByNode(userId, nodeId, jobId);

    if (body.type !== job.type) {
      throw new BadRequestException(
        `result type "${body.type}" does not match job type "${job.type}"`,
      );
    }

    const handler = this.registry.get(job.type);
    if (!handler?.persistNodeResult || !handler.nodeResultSchema) {
      throw new BadRequestException(`job type "${job.type}" is not node-persistable`);
    }

    // Manual .parse (not the global ZodValidationPipe) since the schema is
    // resolved per-job-type at runtime; wrap so the ZodError surfaces as a
    // clean 400 instead of an unhandled 500.
    let parsed: unknown;
    try {
      parsed = handler.nodeResultSchema.parse(body.result);
    } catch (err) {
      throw new BadRequestException(
        `invalid ${job.type} result payload: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      await handler.persistNodeResult(job, parsed);
    } catch (err) {
      // DESIGN CHOICE: a persist crash is treated as a JOB failure — the job is
      // routed through the shared failure/retry state machine (backoff, attempts
      // budget) exactly as if the server-side handler had thrown, and the node
      // receives a 500 so it knows the result was NOT accepted. The node must
      // not retry the submit itself: the server now owns the job's retry
      // lifecycle (the row is back to pending/failed, no longer held under this
      // node's lease).
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Node ${nodeId} result persist failed for EnrichmentJob ${jobId} (type="${job.type}"): ${msg}`,
      );
      await this.terminal.completeFailed(job, err);
      throw new InternalServerErrorException(
        'failed to persist node result; job routed through the failure/retry path',
      );
    }

    await this.terminal.completeSucceeded(job);
    return { ok: true };
  }

  /**
   * Ingest a node-reported failure for a claimed job. Routed through the same
   * terminal failure state machine as the in-process worker: rate-limited
   * reports enter the deferral path (and trip the shared provider-throttle
   * gate); everything else enters the exponential-retry path. The node's
   * `willRetry` flag is advisory only — the server's attempts budget decides.
   */
  async reportJobFailure(
    userId: string,
    nodeId: string,
    jobId: string,
    body: { error: string; rateLimited?: boolean; retryAfterMs?: number | null },
  ): Promise<{ ok: true }> {
    const job = await this.assertJobHeldByNode(userId, nodeId, jobId);

    await this.terminal.completeFailed(job, body.error, {
      rateLimited: body.rateLimited,
      retryAfterMs: body.retryAfterMs ?? null,
    });

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // listNodes
  // -------------------------------------------------------------------------

  async listNodes(userId?: string) {
    const nodes = await this.prisma.workerNode.findMany({
      where: userId ? { createdById: userId } : undefined,
      orderBy: { registeredAt: 'desc' },
    });

    if (nodes.length === 0) {
      return [];
    }

    // Fold per-node claimed-job counts by status in a single grouped query.
    const nodeIds = nodes.map((n) => n.id);
    const grouped = await this.prisma.enrichmentJob.groupBy({
      by: ['claimedByNodeId', 'status'],
      where: { claimedByNodeId: { in: nodeIds } },
      _count: { _all: true },
    });

    const countsByNode = new Map<
      string,
      { running: number; succeeded: number; failed: number }
    >();
    for (const row of grouped) {
      if (!row.claimedByNodeId) {
        continue;
      }
      const bucket =
        countsByNode.get(row.claimedByNodeId) ??
        { running: 0, succeeded: 0, failed: 0 };
      if (row.status === JobStatus.running) {
        bucket.running += row._count._all;
      } else if (row.status === JobStatus.succeeded) {
        bucket.succeeded += row._count._all;
      } else if (row.status === JobStatus.failed) {
        bucket.failed += row._count._all;
      }
      countsByNode.set(row.claimedByNodeId, bucket);
    }

    const now = Date.now();
    const staleMs = staleWindowMs();

    return nodes.map((node) => {
      let health: 'healthy' | 'stale' | 'offline';
      if (node.status === NodeStatus.offline || node.status === NodeStatus.disabled) {
        health = 'offline';
      } else if (
        node.lastHeartbeatAt &&
        now - node.lastHeartbeatAt.getTime() <= staleMs
      ) {
        health = 'healthy';
      } else {
        health = 'stale';
      }

      const jobCounts =
        countsByNode.get(node.id) ?? { running: 0, succeeded: 0, failed: 0 };

      return { ...node, health, jobCounts };
    });
  }

  // -------------------------------------------------------------------------
  // deleteNode (admin)
  // -------------------------------------------------------------------------

  async deleteNode(nodeId: string): Promise<{ deleted: true }> {
    // claimedJobs FK is SetNull, so deleting a node is safe and orphans nothing.
    await this.prisma.workerNode.delete({ where: { id: nodeId } });
    return { deleted: true };
  }

  // -------------------------------------------------------------------------
  // getModelManifest
  // -------------------------------------------------------------------------

  /**
   * Static manifest of the parity models a worker node must download so its
   * enrichment output matches the server. Structure matters more than exact
   * values here.
   *
   * Returns a BARE ARRAY (not `{ models: [...] }`): the CLI's
   * `ApiClient.getModelManifest(): Promise<ModelManifestEntry[]>` unwraps the
   * global `{ data }` envelope and then iterates the result directly.
   *
   * TODO: fill real sha256/bytes hashes
   */
  getModelManifest() {
    return [
      {
        name: 'clip-vit-b32-vision-quantized.onnx',
        url: 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx',
        sha256: null,
        bytes: null,
        targetSubdir: 'models',
      },
      {
        name: 'blazeface-back.json',
        url: 'https://github.com/vladmandic/human-models/raw/main/models/blazeface-back.json',
        sha256: null,
        bytes: null,
        targetSubdir: 'human',
      },
      {
        name: 'faceres.json',
        url: 'https://github.com/vladmandic/human-models/raw/main/models/faceres.json',
        sha256: null,
        bytes: null,
        targetSubdir: 'human',
      },
      {
        name: 'faceres.bin',
        url: 'https://github.com/vladmandic/human-models/raw/main/models/faceres.bin',
        sha256: null,
        bytes: null,
        targetSubdir: 'human',
      },
    ];
  }
}

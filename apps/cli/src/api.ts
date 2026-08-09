import * as fs from 'node:fs';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import {
  withRetry,
  DEFAULT_RETRY_CONFIG,
  parseRetryAfter,
  RETRYABLE_STATUSES,
  type RetryConfig,
} from './http/retry.js';
import {
  CooldownGate,
  DEFAULT_COOLDOWN_CONFIG,
} from './http/cooldown-gate.js';

export interface ApiClientOptions {
  serverUrl: string;
  pat: string;
  /** Retry policy for transient failures (429/503/5xx/network). */
  retry?: RetryConfig;
  /** Shared cooperative throttle. All workers using one ApiClient share it. */
  cooldownGate?: CooldownGate;
}

export interface Circle {
  id: string;
  name: string;
  isPersonal: boolean;
  // other fields may be present but we only need these
}

/** Minimal Media Workflow Automation summary (issue #144 — thin CLI surface). */
export interface WorkflowSummary {
  id: string;
  name: string;
  subjectType: string;
  enabled: boolean;
  trigger: string;
  createdAt: string;
  // other fields may be present but we only need these
}

/** Minimal workflow run summary for `workflow run`/`workflow runs`. */
export interface WorkflowRunSummary {
  id: string;
  status: string;
  triggerType: string;
  matchedCount: number;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  createdAt: string;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Node backup control-plane types (issue #314 — /api/nodes/:id/backup/*)
// ---------------------------------------------------------------------------

/**
 * A node's backup configuration as serialized by the server. Shape mirrors
 * NodeBackupService.serializeConfig (apps/api/src/nodes/node-backup.service.ts);
 * only the fields the CLI relies on are typed, extra fields pass through.
 * Byte fields are STRINGS (BigInt-safe serialization).
 */
export interface NodeBackupConfig {
  nodeId: string;
  enabled: boolean;
  scheduleCron: string | null;
  timezone: string | null;
  /** Empty array = ALL circles the node owner belongs to. */
  circleIds: string[];
  [key: string]: unknown;
}

/**
 * Envelope returned by GET/PUT /api/nodes/:id/backup/config. The backup
 * controller returns `{ config }` at the TOP level (not under `{ data }`), so
 * parseOk passes it through unchanged. `config` is null only on GET before the
 * node's backup has ever been configured.
 */
export interface NodeBackupConfigResult {
  config: NodeBackupConfig | null;
}

export interface UpdateNodeBackupConfigBody {
  enabled?: boolean;
  scheduleCron?: string | null;
  timezone?: string | null;
  circleIds?: string[];
}

// ---------------------------------------------------------------------------
// Node backup run/feed types (issue #316 — the backup engine data plane).
// Shapes mirror NodeBackupService (apps/api/src/nodes/node-backup.service.ts);
// every byte-count field crosses the wire as a STRING (BigInt-safe).
// ---------------------------------------------------------------------------

/** Change-feed keyset cursor: (updatedAt, id), both halves always together. */
export interface BackupFeedCursor {
  updatedAt: string;
  id: string;
}

/** Response envelope of POST /api/nodes/:id/backup/runs (201). */
export interface StartBackupRunResult {
  run: {
    id: string;
    kind: string;
    startedAt: string;
    /** Snapshot of the server checkpoint at run start; halves are null when
     * the node has never acked a page. */
    cursorStart: { updatedAt: string | null; id: string | null };
  };
}

export interface StartBackupRunBody {
  kind: 'incremental' | 'reconcile';
  trigger: 'manual' | 'scheduled';
  cliVersion?: string;
}

/** One change-feed item from GET /api/nodes/:id/backup/changes. */
export interface BackupChangeItem {
  id: string;
  circleId: string;
  updatedAt: string;
  createdAt: string;
  capturedAt: string | null;
  /** Capture-time UTC offset in MINUTES, or null. */
  capturedAtOffset: number | null;
  type: string;
  deletedAt: string | null;
  archivedAt: string | null;
  contentHash: string | null;
  originalFilename: string;
  storage: {
    objectId: string;
    /** Byte size as a decimal STRING. */
    size: string;
    mimeType: string | null;
    status: string;
  } | null;
  /** Presigned GET for the original bytes; null for tombstones, not-ready
   * objects, or presign failures. Minted per page — expires. */
  downloadUrl: string | null;
  downloadUrlExpiresAt: string | null;
  /** The full server-composed schemaVersion-1 sidecar document. */
  sidecar: Record<string, unknown>;
}

/** Response of GET /api/nodes/:id/backup/changes. */
export interface BackupChangesPage {
  items: BackupChangeItem[];
  /** Advances even on a partial page; null only on a zero-item page. */
  nextCursor: BackupFeedCursor | null;
  hasMore: boolean;
  safetyHorizon: string;
}

/** Wire shape of the shared run stats (ack + finish finalStats). */
export interface BackupRunStatsBody {
  itemsDownloaded: number;
  itemsSkipped: number;
  sidecarsWritten: number;
  /** Bytes as a decimal STRING (BigInt-safe). */
  bytesDownloaded: string;
  errors: number;
}

export interface BackupAckBody {
  runId: string;
  cursor: BackupFeedCursor;
  stats: BackupRunStatsBody;
}

export interface BackupAckResult {
  ok: true;
  checkpoint: { updatedAt: string; id: string };
}

export interface FinishBackupRunBody {
  status: 'completed' | 'failed' | 'aborted';
  error?: string;
  finalStats?: BackupRunStatsBody;
}

/** One reconcile-manifest row from GET /api/nodes/:id/backup/manifest. */
export interface BackupManifestItem {
  id: string;
  contentHash: string | null;
  updatedAt: string;
  deletedAt: string | null;
  archivedAt: string | null;
}

export interface BackupManifestPage {
  items: BackupManifestItem[];
  nextAfterId: string | null;
  hasMore: boolean;
}

/** Response of GET /api/nodes/:id/backup/dimensions. */
export interface BackupDimensions {
  albums: Array<{
    id: string;
    name: string;
    description: string | null;
    itemCount: number;
    itemIds: string[];
  }>;
  people: Array<{
    id: string;
    name: string | null;
    favorite: boolean;
    faceCount: number;
  }>;
  tags: Array<{ name: string; itemCount: number }>;
  generatedAt: string;
}

/** Per-attempt configuration for {@link ApiClient.getRaw}. */
export interface GetRawAttemptConfig {
  /** Bytes already on disk — requests `Range: bytes=N-` when > 0. */
  rangeStart?: number;
  /**
   * Called once response headers arrive, before any chunk. `resumed` is true
   * only when rangeStart > 0 AND the server honored the Range request (206);
   * a 200 means the file is being restarted from zero (the destination is
   * truncated).
   */
  onResponse?: (info: { status: number; resumed: boolean }) => void | Promise<void>;
  /** Awaited per chunk BEFORE it is written — bandwidth capping + hashing. */
  onChunk?: (chunk: Buffer) => void | Promise<void>;
}

export interface GetRawOptions {
  signal?: AbortSignal;
  /**
   * Invoked at the start of EVERY attempt (including internal retries) so
   * resume state (existing .part size, partial hash) is recomputed per
   * attempt rather than captured stale from the first try.
   */
  attempt?: () => GetRawAttemptConfig | Promise<GetRawAttemptConfig>;
}

export interface GetRawResult {
  status: number;
  /** Bytes written by this call (excludes pre-existing resumed bytes). */
  bytesWritten: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly serverMessage: string,
    /** Parsed `Retry-After` (ms), when the server supplied one. */
    public readonly retryAfterMs: number | null = null,
    /** Forces retryability even when `status` is not normally retryable. */
    public readonly retryable: boolean = false,
    /** Parsed JSON error body, when the response body was JSON (else undefined).
     * Lets callers read structured error fields beyond `message` — e.g. the
     * `activeRunId` on a backup-run 409. */
    public readonly body: unknown = undefined,
  ) {
    super(`API error ${status}: ${serverMessage}`);
    this.name = 'ApiError';
  }
}

/** A transport-level failure (DNS/connection/socket) with no HTTP response. */
export class NetworkError extends Error {
  public readonly isNetworkError = true;
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Body substrings that indicate provider throttling even on odd status codes. */
const THROTTLE_BODY_RE = /SlowDown|ServiceUnavailable|TooManyRequests|Throttl/i;

// ---------------------------------------------------------------------------
// Job queue types
// ---------------------------------------------------------------------------

export interface JobInsights {
  computedAt: string;
  windowDays: number;
  concurrency: number;
  live: {
    total: number;
    byStatus: { pending: number; running: number; succeeded: number; failed: number };
    pending: number;
    running: number;
    failed: number;
    scheduled: number;
    rateLimited: number;
    retried: number;
    byType: Array<{
      type: string;
      pending: number;
      running: number;
      succeeded: number;
      failed: number;
      total: number;
    }>;
  };
  history: {
    overall: {
      samples: number;
      avgMs: number;
      p50Ms: number;
      p95Ms: number;
      throughputPerMin: number;
    };
    byType: Array<{
      type: string;
      samples: number;
      avgMs: number;
      p50Ms: number;
      p95Ms: number;
      throughputPerMin: number;
    }>;
  };
  eta: {
    totalRemaining: number;
    etaMs: number | null;
    basis: 'live' | 'partial' | 'none';
    perType: Array<{
      type: string;
      remaining: number;
      avgMs: number | null;
      etcMs: number | null;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Worker-node types
// ---------------------------------------------------------------------------

/** Per-capability availability summary reported in heartbeats. */
export type NodeCapabilities = Record<string, { available: boolean; detail?: string }>;

export interface NodeRegisterBody {
  name: string;
  hostname: string;
  platform: string;
  cliVersion: string;
  eligibleTypes: string[];
  concurrency: number;
}

export interface NodeRegisterResult {
  nodeId: string;
  /** True when the server re-attached to an existing (owner, name) node row
   * instead of creating a new one. Optional for older-server compatibility. */
  reattached?: boolean;
}

export interface NodeHeartbeatBody {
  status?: string;
  capabilities?: NodeCapabilities;
  /** Live concurrency cap; propagated so the server re-syncs its stale value. */
  concurrency?: number;
}

export interface NodeClaimBody {
  max?: number;
  types?: string[];
}

/** A queued enrichment job as handed to a worker node. Shape is loosely typed
 *  because the server owns the full job schema; only these fields are relied on. */
export interface NodeJob {
  id: string;
  type: string;
  mediaItemId?: string | null;
  circleId?: string | null;
  [key: string]: unknown;
}

export interface ClaimedNodeJob {
  job: NodeJob;
  /** Signed URL to download the job's input bytes (null for input-less jobs). */
  inputUrl: string | null;
  /** Job-specific parameters resolved server-side. */
  params: Record<string, unknown>;
}

export interface NodeClaimResult {
  jobs: ClaimedNodeJob[];
}

export interface NodeRenewBody {
  leaseMs?: number;
}

/**
 * Response shape for `POST /api/node-credentials` — a durable, least-privilege
 * `nod_` credential minted for a worker node. `token` is the full secret,
 * returned exactly once at creation; `tokenPrefix` is a display-safe prefix
 * used for later identification. `expiresAt` is null for a never-expiring
 * credential (the default enrollment uses this).
 */
export interface NodeCredentialResult {
  id: string;
  name: string;
  token: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface ModelManifestEntry {
  name: string;
  url: string;
  /** Hex SHA-256; null skips verification. */
  sha256: string | null;
  /** Expected byte size; null skips verification. */
  bytes: number | null;
  /** Subdirectory under the models dir the file is stored in. */
  targetSubdir: string;
}

/** Response shape for POST /api/nodes/:id/jobs/:jobId/upload-url. */
export interface JobUploadUrlResult {
  /** Presigned PUT URL to upload output bytes to. */
  url: string;
  /** Server-chosen storage key — echo this back in the job result payload. */
  storageKey: string;
  /** How long `url` remains valid, in seconds. */
  expiresSeconds: number;
}

/**
 * Response shape for POST /api/nodes/:id/jobs/:jobId/credentials — TRANSIENT,
 * per-job provider credentials (mandated alternative to the "AI-proxy"
 * pattern documented, stale, in docs/specs/distributed-nodes.md). `apiKey` is
 * scoped to a single job. Callers MUST hold it only in a local variable for
 * the duration of the compute call and MUST NEVER persist it to disk,
 * config, or logs (the node logger's redaction already covers `apiKey`).
 */
export interface AutoTaggingJobCredentials {
  type: 'auto_tagging';
  /**
   * Configured tagging provider key. Must be kept in sync with the server's
   * registered provider keys — see AiProviderRegistry
   * (apps/api/src/ai/providers/ai-provider.registry.ts).
   */
  provider: 'anthropic' | 'openai';
  model: string;
  apiKey: string;
  baseUrl?: string;
  system: string;
  prompt: string;
  /** Always 'image/jpeg' — the node re-encodes via prepareImageForProcessing. */
  mimeTypeHint: string;
}

export interface GeocodeJobCredentials {
  type: 'geocode';
  /** 'offline' means the server-side GeoNames dataset is active — not node-eligible. */
  provider: 'offline' | 'nominatim' | 'google';
  /** Only present for provider='google'. */
  apiKey?: string;
  /** Only present for provider='nominatim'. */
  baseUrl?: string;
  lat: number;
  lng: number;
}

export type JobCredentials = AutoTaggingJobCredentials | GeocodeJobCredentials;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly pat: string;
  private readonly retry: RetryConfig;
  private readonly gate: CooldownGate;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.serverUrl.replace(/\/$/, '');
    this.pat = opts.pat;
    this.retry = opts.retry ?? DEFAULT_RETRY_CONFIG;
    this.gate = opts.cooldownGate ?? new CooldownGate(DEFAULT_COOLDOWN_CONFIG);
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.pat}`,
    };
  }

  /**
   * Perform a single fetch through the cooldown gate, mapping failures to
   * typed errors. On a throttle (429/503 or a SlowDown body) the gate is
   * tripped so sibling workers back off too. Successful responses are returned
   * with their body unread for the caller to consume.
   */
  private async fetchWithGate(url: string, init: RequestInit): Promise<Response> {
    await this.gate.acquire();

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Transport failure — no HTTP response. Retryable.
      throw new NetworkError(err instanceof Error ? err.message : String(err));
    }

    if (!res.ok) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      const bodyText = await res.text().catch(() => '');
      const bodyThrottle = THROTTLE_BODY_RE.test(bodyText);

      if (RETRYABLE_STATUSES.has(res.status) || bodyThrottle) {
        this.gate.trip(retryAfterMs);
      }

      const msg = extractMessage(bodyText) || res.statusText || 'Request failed';
      throw new ApiError(res.status, msg, retryAfterMs, bodyThrottle, parseJsonSafe(bodyText));
    }

    this.gate.recordSuccess();
    return res;
  }

  /** Run an operation with the configured retry policy. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, this.retry);
  }

  async get<T>(path: string): Promise<T> {
    return this.run(async () => {
      const res = await this.fetchWithGate(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          ...this.authHeaders(),
          Accept: 'application/json',
        },
      });
      return this.parseOk<T>(res);
    });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.run(async () => {
      const res = await this.fetchWithGate(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      return this.parseOk<T>(res);
    });
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.run(async () => {
      const res = await this.fetchWithGate(`${this.baseUrl}${path}`, {
        method: 'PUT',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      return this.parseOk<T>(res);
    });
  }

  /**
   * PUT a raw buffer directly to a presigned URL.
   * No auth header — the URL is pre-signed, and S3 rejects extra auth headers.
   * Returns the ETag response header. Retries transient/throttle failures
   * (S3 `503 SlowDown`, R2 `429`) via the shared retry + cooldown machinery.
   */
  async putRaw(url: string, buffer: Buffer, contentType?: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    return this.run(async () => {
      const res = await this.fetchWithGate(url, {
        method: 'PUT',
        headers,
        // Cast to BodyInit: Node 18+ fetch accepts Buffer at runtime;
        // the @types/node fetch overload doesn't list Buffer but it works.
        body: buffer as unknown as BodyInit,
      });
      return res.headers.get('etag') ?? res.headers.get('ETag') ?? '';
    });
  }

  async listCircles(): Promise<Circle[]> {
    // GET /api/circles returns a paginated envelope: { data: { items, total, … } }.
    // parseOk() unwraps `data`, leaving the pagination object — so pull `items`.
    // Tolerate a bare array too, in case the endpoint is ever simplified.
    const res = await this.get<Circle[] | { items?: Circle[] }>('/api/circles');
    if (Array.isArray(res)) return res;
    return res?.items ?? [];
  }

  // -------------------------------------------------------------------------
  // Media Workflow Automation (issue #144) — thin, PAT-authed, circle-scoped.
  // The web UI is the primary surface; these mirror listCircles' envelope
  // unwrapping (parseOk strips { data }, leaving the paginated { items, meta }).
  // -------------------------------------------------------------------------

  async listWorkflows(circleId: string): Promise<WorkflowSummary[]> {
    const res = await this.get<WorkflowSummary[] | { items?: WorkflowSummary[] }>(
      `/api/workflows?circleId=${encodeURIComponent(circleId)}`,
    );
    if (Array.isArray(res)) return res;
    return res?.items ?? [];
  }

  async runWorkflow(
    workflowId: string,
    body: { maxItems?: number } = {},
  ): Promise<{ runId: string; status: string }> {
    return this.post<{ runId: string; status: string }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/run`,
      body,
    );
  }

  async listWorkflowRuns(workflowId: string): Promise<WorkflowRunSummary[]> {
    const res = await this.get<WorkflowRunSummary[] | { items?: WorkflowRunSummary[] }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/runs`,
    );
    if (Array.isArray(res)) return res;
    return res?.items ?? [];
  }

  // -------------------------------------------------------------------------
  // Node backup control plane (issue #314) — /api/nodes/:id/backup/*
  // -------------------------------------------------------------------------

  /**
   * Get a node's backup configuration. The server returns `{ config: null }`
   * when backup has never been configured for the node.
   */
  getNodeBackupConfig(nodeId: string): Promise<NodeBackupConfigResult> {
    return this.get<NodeBackupConfigResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/backup/config`,
    );
  }

  /**
   * Create or update a node's backup configuration (partial upsert — only the
   * provided keys change). Response matches GET: `{ config }`.
   */
  putNodeBackupConfig(
    nodeId: string,
    body: UpdateNodeBackupConfigBody,
  ): Promise<NodeBackupConfigResult> {
    return this.put<NodeBackupConfigResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/backup/config`,
      body,
    );
  }

  // -------------------------------------------------------------------------
  // Node backup data plane (issue #316) — runs / changes / ack / finish /
  // manifest / dimensions. All envelopes are TOP-LEVEL (no { data } wrapper),
  // matching NodeBackupController; parseOk passes them through unchanged.
  // -------------------------------------------------------------------------

  /** Start a backup run. 409 (ApiError with body.activeRunId) when one is active. */
  startNodeBackupRun(nodeId: string, body: StartBackupRunBody): Promise<StartBackupRunResult> {
    return this.post<StartBackupRunResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/backup/runs`,
      body,
    );
  }

  /** Fetch one keyset page of the change feed. `cursor` null = from the start. */
  getNodeBackupChanges(
    nodeId: string,
    q: { runId: string; cursor?: BackupFeedCursor | null; limit?: number },
  ): Promise<BackupChangesPage> {
    const params = new URLSearchParams({ runId: q.runId });
    if (q.cursor) {
      params.set('updatedAfter', q.cursor.updatedAt);
      params.set('afterId', q.cursor.id);
    }
    if (q.limit !== undefined) params.set('limit', String(q.limit));
    return this.get<BackupChangesPage>(
      `/api/nodes/${encodeURIComponent(nodeId)}/backup/changes?${params.toString()}`,
    );
  }

  /** Acknowledge a committed page, advancing the server checkpoint. */
  ackNodeBackup(nodeId: string, body: BackupAckBody): Promise<BackupAckResult> {
    return this.post<BackupAckResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/backup/ack`,
      body,
    );
  }

  /** Finish a backup run with a terminal status (+ optional finalStats). */
  finishNodeBackupRun(
    nodeId: string,
    runId: string,
    body: FinishBackupRunBody,
  ): Promise<{ ok: true }> {
    return this.post<{ ok: true }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/backup/runs/${encodeURIComponent(runId)}/finish`,
      body,
    );
  }

  /** Fetch one id-keyset page of the reconcile manifest. */
  getNodeBackupManifest(
    nodeId: string,
    q: { runId: string; afterId?: string; limit?: number },
  ): Promise<BackupManifestPage> {
    const params = new URLSearchParams({ runId: q.runId });
    if (q.afterId !== undefined) params.set('afterId', q.afterId);
    if (q.limit !== undefined) params.set('limit', String(q.limit));
    return this.get<BackupManifestPage>(
      `/api/nodes/${encodeURIComponent(nodeId)}/backup/manifest?${params.toString()}`,
    );
  }

  /** Fetch the album/person/tag dimension catalogs for the backup scope. */
  getNodeBackupDimensions(nodeId: string): Promise<BackupDimensions> {
    return this.get<BackupDimensions>(
      `/api/nodes/${encodeURIComponent(nodeId)}/backup/dimensions`,
    );
  }

  /**
   * Stream a presigned GET to a local file (issue #316) — the download
   * counterpart to {@link putRaw}. NO auth header (the URL is presigned; S3
   * rejects extra auth). Routed through the shared retry + cooldown-gate
   * machinery, so 429/503/Retry-After brake every worker sharing this client.
   *
   * Resume support: `opts.attempt` is re-invoked on every retry attempt so the
   * caller can recompute the Range start (and re-hash any partial bytes)
   * against the CURRENT on-disk state. When the attempt's rangeStart > 0 and
   * the server honors it (206), the destination is opened in append mode;
   * a 200 truncates and restarts from zero.
   */
  async getRaw(url: string, destPath: string, opts: GetRawOptions = {}): Promise<GetRawResult> {
    return this.run(async () => {
      if (opts.signal?.aborted) {
        // Plain Error (not NetworkError) so an abort is never retried.
        throw new Error('Download aborted');
      }
      const cfg = (await opts.attempt?.()) ?? {};
      const rangeStart = cfg.rangeStart ?? 0;

      const headers: Record<string, string> = {};
      if (rangeStart > 0) headers['Range'] = `bytes=${rangeStart}-`;

      const res = await this.fetchWithGate(url, {
        method: 'GET',
        headers,
        signal: opts.signal,
      });

      const resumed = rangeStart > 0 && res.status === 206;
      await cfg.onResponse?.({ status: res.status, resumed });

      if (!res.body) {
        throw new NetworkError('Response has no body');
      }

      const out = fs.createWriteStream(destPath, { flags: resumed ? 'a' : 'w' });
      let bytesWritten = 0;
      const nodeStream = Readable.fromWeb(
        res.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      );

      try {
        for await (const chunk of nodeStream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          await cfg.onChunk?.(buf);
          if (!out.write(buf)) {
            await once(out, 'drain');
          }
          bytesWritten += buf.length;
        }
        out.end();
        await once(out, 'close');
      } catch (err) {
        out.destroy();
        if (opts.signal?.aborted) {
          throw new Error('Download aborted');
        }
        // Mid-stream transport failures are retryable; the next attempt
        // recomputes its Range from the bytes that DID land on disk.
        throw err instanceof Error && (err as Partial<NetworkError>).isNetworkError
          ? err
          : new NetworkError(err instanceof Error ? err.message : String(err));
      }

      return { status: res.status, bytesWritten };
    });
  }

  /** Fetch live job queue insights. windowDays defaults to 7 on the server. */
  getJobInsights(windowDays?: number): Promise<JobInsights> {
    const qs = windowDays !== undefined ? `?windowDays=${windowDays}` : '';
    return this.get<JobInsights>(`/api/admin/jobs/insights${qs}`);
  }

  // -------------------------------------------------------------------------
  // Worker-node endpoints
  // -------------------------------------------------------------------------

  /**
   * Mint a durable, least-privilege node credential (`nod_` token) via
   * `POST /api/node-credentials`. Requires a normal authenticated session/PAT
   * (NOT a `nod_` token) on this client. Pass `expiresAt = null` (the default)
   * for a never-expiring credential, or an ISO 8601 string to bound its life.
   * Returns the full `token` exactly once — the caller must persist it, as it
   * is never returned again.
   */
  createNodeCredential(name: string, expiresAt?: string | null): Promise<NodeCredentialResult> {
    const body: { name: string; expiresAt?: string | null } = { name };
    if (expiresAt !== undefined) body.expiresAt = expiresAt;
    return this.post<NodeCredentialResult>('/api/node-credentials', body);
  }

  /** Register this machine as a worker node; returns the assigned nodeId. */
  registerNode(body: NodeRegisterBody): Promise<NodeRegisterResult> {
    return this.post<NodeRegisterResult>('/api/nodes/register', body);
  }

  /** Deregister a worker node (called on graceful shutdown). */
  deregisterNode(nodeId: string): Promise<unknown> {
    return this.post<unknown>(
      `/api/nodes/${encodeURIComponent(nodeId)}/deregister`,
      {},
    );
  }

  /** Post a heartbeat with optional status + capability summary. */
  heartbeatNode(nodeId: string, body: NodeHeartbeatBody): Promise<unknown> {
    return this.post<unknown>(
      `/api/nodes/${encodeURIComponent(nodeId)}/heartbeat`,
      body,
    );
  }

  /** Claim up to `max` jobs of the given types for processing. */
  claimNodeJobs(nodeId: string, body: NodeClaimBody): Promise<NodeClaimResult> {
    return this.post<NodeClaimResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/claim`,
      body,
    );
  }

  /** Renew the lease on an in-flight job so the server doesn't reclaim it. */
  renewLease(nodeId: string, jobId: string, body: NodeRenewBody): Promise<unknown> {
    return this.post<unknown>(
      `/api/nodes/${encodeURIComponent(nodeId)}/jobs/${encodeURIComponent(jobId)}/renew`,
      body,
    );
  }

  /** Fetch the model download manifest for node compute capabilities. */
  getModelManifest(): Promise<ModelManifestEntry[]> {
    return this.get<ModelManifestEntry[]>('/api/nodes/models/manifest');
  }

  /**
   * Get a presigned upload URL for a claimed job to PUT output bytes to
   * (`POST /api/nodes/:id/jobs/:jobId/upload-url`) — currently used by the
   * thumbnail node-compute path: the server chooses the storage key, the
   * node PUTs its computed JPEG directly to the returned `url`, then submits
   * `{ storageKey, width, height, bytes }` via {@link submitJobResult}.
   */
  getJobUploadUrl(nodeId: string, jobId: string): Promise<JobUploadUrlResult> {
    return this.post<JobUploadUrlResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/jobs/${encodeURIComponent(jobId)}/upload-url`,
      {},
    );
  }

  /**
   * Fetch TRANSIENT, per-job provider credentials for a node-eligible job
   * (currently `auto_tagging` and `geocode`) via
   * `POST /api/nodes/:id/jobs/:jobId/credentials`. The response contains a
   * plaintext provider API key scoped to THIS job only — callers MUST hold
   * it in a local variable only, for the duration of the compute call, and
   * MUST NEVER persist it to disk, config, or logs.
   */
  getJobCredentials(nodeId: string, jobId: string): Promise<JobCredentials> {
    return this.post<JobCredentials>(
      `/api/nodes/${encodeURIComponent(nodeId)}/jobs/${encodeURIComponent(jobId)}/credentials`,
      {},
    );
  }

  /**
   * Submit a completed job's result.
   *
   * POSTs the typed envelope `{ type, result }` expected by
   * `POST /api/nodes/:id/jobs/:jobId/result` — the server dispatches on `type`
   * and zod-validates the per-type `result` payload (invalid → 400).
   */
  submitJobResult(
    nodeId: string,
    jobId: string,
    type: string,
    result: unknown,
  ): Promise<unknown> {
    return this.post<unknown>(
      `/api/nodes/${encodeURIComponent(nodeId)}/jobs/${encodeURIComponent(jobId)}/result`,
      { type, result },
    );
  }

  /**
   * Report a job failure so the server can requeue/fail it
   * (`POST /api/nodes/:id/jobs/:jobId/failure`). `rateLimited`/`retryAfterMs`
   * mirror the server's `ReportJobFailureDto` (apps/api/src/nodes/dto/compute-result.dto.ts)
   * — set by node-engine.ts's processJob when the compute failure was a
   * `ProviderRateLimitError` (@memoriahub/enrichment-compute/rate-limit), so
   * the server routes the job through `EnrichmentTerminalService`'s
   * rate-limit deferral/backoff path instead of the normal-failure retry path.
   */
  reportJobFailure(
    nodeId: string,
    jobId: string,
    body: { error: string; willRetry?: boolean; rateLimited?: boolean; retryAfterMs?: number },
  ): Promise<unknown> {
    return this.post<unknown>(
      `/api/nodes/${encodeURIComponent(nodeId)}/jobs/${encodeURIComponent(jobId)}/failure`,
      body,
    );
  }

  /** Parse a successful JSON response, unwrapping the standard { data } envelope. */
  private async parseOk<T>(res: Response): Promise<T> {
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'data' in parsed
    ) {
      return (parsed as { data: T })['data'];
    }

    return parsed as T;
  }
}

/** Parse a body as JSON, returning undefined for empty/non-JSON text. */
function parseJsonSafe(bodyText: string): unknown {
  if (!bodyText) return undefined;
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return undefined;
  }
}

/** Pull a human-readable message out of a JSON error body, if present. */
function extractMessage(bodyText: string): string {
  if (!bodyText) return '';
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'message' in parsed
    ) {
      return String((parsed as Record<string, unknown>)['message']);
    }
  } catch {
    // Not JSON (e.g. S3 XML) — fall through to the raw text.
  }
  return bodyText;
}

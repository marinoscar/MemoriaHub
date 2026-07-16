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

export interface BackupRunResult {
  runId: string;
  scope: string;
  copied: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export interface BackupObject {
  mediaItemId: string;
  storageKey: string;
  downloadUrl: string;
  originalFilename: string;
  mimeType: string;
  size: number;
  circleId: string;
}

export interface BackupObjectsResult {
  items: BackupObject[];
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly serverMessage: string,
    /** Parsed `Retry-After` (ms), when the server supplied one. */
    public readonly retryAfterMs: number | null = null,
    /** Forces retryability even when `status` is not normally retryable. */
    public readonly retryable: boolean = false,
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
      throw new ApiError(res.status, msg, retryAfterMs, bodyThrottle);
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

  async triggerBackup(body: { circleId?: string; all?: boolean }): Promise<BackupRunResult> {
    return this.post<BackupRunResult>('/api/admin/backup', body);
  }

  async listBackupObjects(circleId?: string): Promise<BackupObjectsResult> {
    const qs = circleId ? `?circleId=${encodeURIComponent(circleId)}` : '';
    return this.get<BackupObjectsResult>(`/api/admin/backup/objects${qs}`);
  }

  /** Fetch live job queue insights. windowDays defaults to 7 on the server. */
  getJobInsights(windowDays?: number): Promise<JobInsights> {
    const qs = windowDays !== undefined ? `?windowDays=${windowDays}` : '';
    return this.get<JobInsights>(`/api/admin/jobs/insights${qs}`);
  }

  // -------------------------------------------------------------------------
  // Worker-node endpoints
  // -------------------------------------------------------------------------

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

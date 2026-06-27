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

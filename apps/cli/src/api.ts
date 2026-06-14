export interface ApiClientOptions {
  serverUrl: string;
  pat: string;
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
  ) {
    super(`API error ${status}: ${serverMessage}`);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly pat: string;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.serverUrl.replace(/\/$/, '');
    this.pat = opts.pat;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.pat}`,
    };
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        ...this.authHeaders(),
        Accept: 'application/json',
      },
    });
    return this.parseResponse<T>(res);
  }

  async listCircles(): Promise<Circle[]> {
    return this.get<Circle[]>('/api/circles');
  }

  async triggerBackup(body: { circleId?: string; all?: boolean }): Promise<BackupRunResult> {
    return this.post<BackupRunResult>('/api/admin/backup', body);
  }

  async listBackupObjects(circleId?: string): Promise<BackupObjectsResult> {
    const qs = circleId ? `?circleId=${encodeURIComponent(circleId)}` : '';
    return this.get<BackupObjectsResult>(`/api/admin/backup/objects${qs}`);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(res);
  }

  /**
   * PUT a raw buffer directly to a presigned URL.
   * No auth header — the URL is pre-signed, and S3 rejects extra auth headers.
   * Returns the ETag response header.
   */
  async putRaw(url: string, buffer: Buffer, contentType?: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    const res = await fetch(url, {
      method: 'PUT',
      headers,
      // Cast to BodyInit: Node 18+ fetch accepts Buffer at runtime;
      // the @types/node fetch overload doesn't list Buffer but it works.
      body: buffer as unknown as BodyInit,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, text || 'Part upload failed');
    }
    const etag = res.headers.get('etag') ?? res.headers.get('ETag') ?? '';
    return etag;
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const msg =
        typeof parsed === 'object' &&
        parsed !== null &&
        'message' in parsed
          ? String((parsed as Record<string, unknown>)['message'])
          : text;
      throw new ApiError(res.status, msg);
    }

    // Unwrap the standard { data: T } envelope if present
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

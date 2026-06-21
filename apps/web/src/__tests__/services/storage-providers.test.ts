import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  getStorageSettings,
  getStorageProviderDescriptors,
  putStorageCredentials,
  deleteStorageCredentials,
  testStorageProvider,
  setActiveStorageProvider,
  triggerMigration,
  listMigrationRuns,
  getMigrationRun,
  cancelMigration,
} from '../../services/storage-providers';
import { api, ApiError } from '../../services/api';

// We test through the real `api` singleton so that requests go through MSW.
beforeEach(() => {
  api.setAccessToken('test-token');
});
afterEach(() => {
  api.setAccessToken(null);
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const mockS3Row = {
  provider: 's3',
  label: 'AWS S3',
  configured: true,
  enabled: true,
  requiresCredentials: true,
  accessKeyId: 'AKID1234',
  region: 'us-east-1',
  bucket: 'my-bucket',
  endpoint: null,
  last4: 'wxyz',
  updatedAt: '2024-01-01T00:00:00Z',
};

const mockStorageSettings = {
  providers: [mockS3Row],
  knownProviders: [
    {
      provider: 'r2',
      label: 'Cloudflare R2',
      configured: false,
      enabled: false,
      requiresCredentials: true,
      accessKeyId: null,
      region: null,
      bucket: null,
      endpoint: null,
      last4: null,
    },
    {
      provider: 'local',
      label: 'Local Disk',
      configured: true,
      enabled: true,
      requiresCredentials: false,
      accessKeyId: null,
      region: null,
      bucket: null,
      endpoint: null,
      last4: null,
    },
  ],
  activeProvider: 's3',
};

const mockDescriptors = [
  {
    key: 's3',
    label: 'AWS S3',
    requiresCredentials: true,
    fields: ['accessKeyId', 'secretAccessKey', 'bucket', 'region'],
    endpointRequired: false,
  },
  {
    key: 'r2',
    label: 'Cloudflare R2',
    requiresCredentials: true,
    fields: ['accessKeyId', 'secretAccessKey', 'bucket', 'region', 'endpoint'],
    endpointRequired: true,
  },
  {
    key: 'local',
    label: 'Local Disk',
    requiresCredentials: false,
    fields: [],
    endpointRequired: false,
  },
];

const mockMigrationRun = {
  id: 'run-1',
  sourceProvider: 's3',
  targetProvider: 'r2',
  status: 'running',
  totalCount: 100,
  migratedCount: 42,
  failedCount: 0,
  skippedCount: 0,
  startedAt: '2024-01-01T00:00:00Z',
  finishedAt: null,
  lastError: null,
};

// ---------------------------------------------------------------------------
// getStorageSettings
// ---------------------------------------------------------------------------

describe('getStorageSettings', () => {
  it('sends GET to /storage-settings and returns the settings', async () => {
    server.use(
      http.get('*/api/storage-settings', () =>
        HttpResponse.json({ data: mockStorageSettings }),
      ),
    );

    const result = await getStorageSettings();

    expect(result).toEqual(mockStorageSettings);
  });

  it('includes authorization header', async () => {
    let authHeader: string | null = null;

    server.use(
      http.get('*/api/storage-settings', ({ request }) => {
        authHeader = request.headers.get('Authorization');
        return HttpResponse.json({ data: mockStorageSettings });
      }),
    );

    await getStorageSettings();

    expect(authHeader).toBe('Bearer test-token');
  });

  it('propagates ApiError on 403', async () => {
    server.use(
      http.get('*/api/storage-settings', () =>
        HttpResponse.json({ message: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 }),
      ),
    );

    await expect(getStorageSettings()).rejects.toThrow(ApiError);
  });

  it('propagates ApiError on 500', async () => {
    server.use(
      http.get('*/api/storage-settings', () => new HttpResponse(null, { status: 500 })),
    );

    await expect(getStorageSettings()).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// getStorageProviderDescriptors
// ---------------------------------------------------------------------------

describe('getStorageProviderDescriptors', () => {
  it('sends GET to /storage-settings/providers and returns descriptors', async () => {
    let capturedPath = '';

    server.use(
      http.get('*/api/storage-settings/providers', ({ request }) => {
        capturedPath = new URL(request.url).pathname;
        return HttpResponse.json({ data: mockDescriptors });
      }),
    );

    const result = await getStorageProviderDescriptors();

    expect(capturedPath).toContain('/storage-settings/providers');
    expect(result).toEqual(mockDescriptors);
  });
});

// ---------------------------------------------------------------------------
// putStorageCredentials
// ---------------------------------------------------------------------------

describe('putStorageCredentials', () => {
  it('sends PUT to /storage-settings/credentials/:provider with the body', async () => {
    let capturedBody: unknown = null;
    let capturedUrl = '';

    server.use(
      http.put('*/api/storage-settings/credentials/:provider', async ({ request }) => {
        capturedBody = await request.json();
        capturedUrl = request.url;
        return HttpResponse.json({ data: mockS3Row });
      }),
    );

    const body = {
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      bucket: 'my-bucket',
      region: 'us-east-1',
      enabled: true,
    };

    await putStorageCredentials('s3', body);

    expect(capturedUrl).toContain('/storage-settings/credentials/s3');
    expect(capturedBody).toEqual(body);
  });

  it('returns the updated StorageProviderRow', async () => {
    server.use(
      http.put('*/api/storage-settings/credentials/:provider', () =>
        HttpResponse.json({ data: mockS3Row }),
      ),
    );

    const result = await putStorageCredentials('s3', { enabled: true });

    expect(result).toEqual(mockS3Row);
  });

  it('propagates ApiError on 400', async () => {
    server.use(
      http.put('*/api/storage-settings/credentials/:provider', () =>
        HttpResponse.json({ message: 'Bad Request', code: 'BAD_REQUEST' }, { status: 400 }),
      ),
    );

    await expect(putStorageCredentials('s3', {})).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// deleteStorageCredentials
// ---------------------------------------------------------------------------

describe('deleteStorageCredentials', () => {
  it('sends DELETE to /storage-settings/credentials/:provider', async () => {
    let capturedUrl = '';

    server.use(
      http.delete('*/api/storage-settings/credentials/:provider', ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await deleteStorageCredentials('s3');

    expect(capturedUrl).toContain('/storage-settings/credentials/s3');
  });

  it('resolves to undefined (void) on success', async () => {
    server.use(
      http.delete('*/api/storage-settings/credentials/:provider', () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );

    const result = await deleteStorageCredentials('s3');

    expect(result).toBeUndefined();
  });

  it('propagates ApiError on 404', async () => {
    server.use(
      http.delete('*/api/storage-settings/credentials/:provider', () =>
        HttpResponse.json({ message: 'Not found', code: 'NOT_FOUND' }, { status: 404 }),
      ),
    );

    await expect(deleteStorageCredentials('nonexistent')).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// testStorageProvider
// ---------------------------------------------------------------------------

describe('testStorageProvider', () => {
  it('sends POST to /storage-settings/test with provider body', async () => {
    let capturedBody: unknown = null;

    server.use(
      http.post('*/api/storage-settings/test', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ data: { ok: true, bucket: 'my-bucket', region: 'us-east-1' } });
      }),
    );

    await testStorageProvider({ provider: 's3', bucket: 'my-bucket', region: 'us-east-1' });

    expect(capturedBody).toEqual({ provider: 's3', bucket: 'my-bucket', region: 'us-east-1' });
  });

  it('returns ok:true on success with metadata', async () => {
    server.use(
      http.post('*/api/storage-settings/test', () =>
        HttpResponse.json({ data: { ok: true, bucket: 'my-bucket', region: 'us-east-1', endpoint: null } }),
      ),
    );

    const result = await testStorageProvider({ provider: 's3' });

    expect(result.ok).toBe(true);
    expect(result.bucket).toBe('my-bucket');
  });

  it('returns ok:false with error message on failure', async () => {
    server.use(
      http.post('*/api/storage-settings/test', () =>
        HttpResponse.json({ data: { ok: false, error: 'Invalid credentials' } }),
      ),
    );

    const result = await testStorageProvider({ provider: 's3' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid credentials');
  });

  it('propagates ApiError on 403', async () => {
    server.use(
      http.post('*/api/storage-settings/test', () =>
        HttpResponse.json({ message: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 }),
      ),
    );

    await expect(testStorageProvider({ provider: 's3' })).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// setActiveStorageProvider
// ---------------------------------------------------------------------------

describe('setActiveStorageProvider', () => {
  it('sends PUT to /storage-settings/active with the provider', async () => {
    let capturedBody: unknown = null;
    let capturedUrl = '';

    server.use(
      http.put('*/api/storage-settings/active', async ({ request }) => {
        capturedBody = await request.json();
        capturedUrl = request.url;
        return HttpResponse.json({ data: { activeProvider: 'r2' } });
      }),
    );

    await setActiveStorageProvider('r2');

    expect(capturedUrl).toContain('/storage-settings/active');
    expect(capturedBody).toEqual({ provider: 'r2' });
  });

  it('returns the updated activeProvider', async () => {
    server.use(
      http.put('*/api/storage-settings/active', () =>
        HttpResponse.json({ data: { activeProvider: 'local' } }),
      ),
    );

    const result = await setActiveStorageProvider('local');

    expect(result).toEqual({ activeProvider: 'local' });
  });
});

// ---------------------------------------------------------------------------
// triggerMigration
// ---------------------------------------------------------------------------

describe('triggerMigration', () => {
  it('sends POST to /storage-settings/migrate with source and target', async () => {
    let capturedBody: unknown = null;

    server.use(
      http.post('*/api/storage-settings/migrate', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ data: { runId: 'run-1', totalCount: 50 } });
      }),
    );

    await triggerMigration({ sourceProvider: 's3', targetProvider: 'r2' });

    expect(capturedBody).toEqual({ sourceProvider: 's3', targetProvider: 'r2' });
  });

  it('returns runId and totalCount', async () => {
    server.use(
      http.post('*/api/storage-settings/migrate', () =>
        HttpResponse.json({ data: { runId: 'run-abc', totalCount: 200 } }),
      ),
    );

    const result = await triggerMigration({ sourceProvider: 's3', targetProvider: 'local' });

    expect(result.runId).toBe('run-abc');
    expect(result.totalCount).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// listMigrationRuns
// ---------------------------------------------------------------------------

describe('listMigrationRuns', () => {
  it('sends GET to /storage-settings/migrate and returns paginated runs', async () => {
    let capturedPath = '';
    const mockResponse = {
      items: [mockMigrationRun],
      meta: { page: 1, pageSize: 20, total: 1 },
    };

    server.use(
      http.get('*/api/storage-settings/migrate', ({ request }) => {
        capturedPath = new URL(request.url).pathname;
        return HttpResponse.json({ data: mockResponse });
      }),
    );

    const result = await listMigrationRuns();

    expect(capturedPath).toContain('/storage-settings/migrate');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('run-1');
    expect(result.meta.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getMigrationRun
// ---------------------------------------------------------------------------

describe('getMigrationRun', () => {
  it('sends GET to /storage-settings/migrate/:runId', async () => {
    let capturedUrl = '';

    server.use(
      http.get('*/api/storage-settings/migrate/:runId', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: mockMigrationRun });
      }),
    );

    await getMigrationRun('run-1');

    expect(capturedUrl).toContain('/storage-settings/migrate/run-1');
  });

  it('returns the migration run data', async () => {
    server.use(
      http.get('*/api/storage-settings/migrate/:runId', () =>
        HttpResponse.json({ data: mockMigrationRun }),
      ),
    );

    const result = await getMigrationRun('run-1');

    expect(result).toEqual(mockMigrationRun);
  });

  it('propagates ApiError on 404', async () => {
    server.use(
      http.get('*/api/storage-settings/migrate/:runId', () =>
        HttpResponse.json({ message: 'Not found', code: 'NOT_FOUND' }, { status: 404 }),
      ),
    );

    await expect(getMigrationRun('nonexistent')).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// cancelMigration
// ---------------------------------------------------------------------------

describe('cancelMigration', () => {
  it('sends POST to /storage-settings/migrate/:runId/cancel', async () => {
    let capturedUrl = '';

    server.use(
      http.post('*/api/storage-settings/migrate/:runId/cancel', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: { ...mockMigrationRun, status: 'cancelled' } });
      }),
    );

    await cancelMigration('run-1');

    expect(capturedUrl).toContain('/storage-settings/migrate/run-1/cancel');
  });

  it('returns the updated migration run with cancelled status', async () => {
    server.use(
      http.post('*/api/storage-settings/migrate/:runId/cancel', () =>
        HttpResponse.json({ data: { ...mockMigrationRun, status: 'cancelled' } }),
      ),
    );

    const result = await cancelMigration('run-1');

    expect(result.status).toBe('cancelled');
    expect(result.id).toBe('run-1');
  });
});

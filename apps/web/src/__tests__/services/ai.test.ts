import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  getAiSettings,
  putAiCredentials,
  deleteAiCredentials,
  testAiProvider,
  getAiModels,
  putAiSearchFeature,
} from '../../services/ai';
import { api, ApiError } from '../../services/api';

// We test through the real `api` singleton so that requests go through MSW.
// Reset the access token between tests.
beforeEach(() => {
  api.setAccessToken('test-token');
});
afterEach(() => {
  api.setAccessToken(null);
});

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const mockAiSettings = {
  providers: [
    { provider: 'openai', configured: true, enabled: true, last4: 'abcd', baseUrl: null },
  ],
  knownProviders: [
    { provider: 'anthropic', configured: false, enabled: false, last4: null, baseUrl: null },
  ],
  features: {
    search: { provider: 'openai', model: 'gpt-4o' },
  },
  conversations: {
    archiveAfterDays: 30,
    deleteAfterArchiveDays: 30,
  },
};

// ---------------------------------------------------------------------------
// getAiSettings
// ---------------------------------------------------------------------------

describe('getAiSettings', () => {
  it('returns the AI settings data on success', async () => {
    server.use(
      http.get('*/api/ai/settings', () => {
        return HttpResponse.json({ data: mockAiSettings });
      }),
    );

    const result = await getAiSettings();

    expect(result).toEqual(mockAiSettings);
  });

  it('sends the request to /ai/settings', async () => {
    let capturedPath = '';

    server.use(
      http.get('*/api/ai/settings', ({ request }) => {
        capturedPath = new URL(request.url).pathname;
        return HttpResponse.json({ data: mockAiSettings });
      }),
    );

    await getAiSettings();

    expect(capturedPath).toContain('/ai/settings');
  });

  it('includes authorization header', async () => {
    let authHeader: string | null = null;

    server.use(
      http.get('*/api/ai/settings', ({ request }) => {
        authHeader = request.headers.get('Authorization');
        return HttpResponse.json({ data: mockAiSettings });
      }),
    );

    await getAiSettings();

    expect(authHeader).toBe('Bearer test-token');
  });

  it('propagates ApiError on 403', async () => {
    server.use(
      http.get('*/api/ai/settings', () => {
        return HttpResponse.json({ message: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 });
      }),
    );

    await expect(getAiSettings()).rejects.toThrow(ApiError);
  });

  it('propagates ApiError on 500', async () => {
    server.use(
      http.get('*/api/ai/settings', () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    await expect(getAiSettings()).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// putAiCredentials
// ---------------------------------------------------------------------------

describe('putAiCredentials', () => {
  it('sends PUT to /ai/credentials/:provider with the correct body', async () => {
    let capturedBody: unknown = null;
    let capturedUrl = '';

    server.use(
      http.put('*/api/ai/credentials/:provider', async ({ request }) => {
        capturedBody = await request.json();
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await putAiCredentials('openai', { apiKey: 'sk-test', baseUrl: 'https://api.openai.com', enabled: true });

    expect(capturedUrl).toContain('/ai/credentials/openai');
    expect(capturedBody).toEqual({ apiKey: 'sk-test', baseUrl: 'https://api.openai.com', enabled: true });
  });

  it('works without optional fields (baseUrl / enabled)', async () => {
    let capturedBody: unknown = null;

    server.use(
      http.put('*/api/ai/credentials/:provider', async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await putAiCredentials('anthropic', { apiKey: 'test-key' });

    expect(capturedBody).toEqual({ apiKey: 'test-key' });
  });

  it('resolves to undefined (void) on 200', async () => {
    server.use(
      http.put('*/api/ai/credentials/:provider', () => {
        return HttpResponse.json({ data: {} });
      }),
    );

    const result = await putAiCredentials('openai', { apiKey: 'key' });

    // void return — no meaningful value asserted, just confirm no throw
    expect(result).toBeUndefined();
  });

  it('propagates ApiError on 400', async () => {
    server.use(
      http.put('*/api/ai/credentials/:provider', () => {
        return HttpResponse.json({ message: 'Bad Request', code: 'BAD_REQUEST' }, { status: 400 });
      }),
    );

    await expect(putAiCredentials('openai', { apiKey: '' })).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// deleteAiCredentials
// ---------------------------------------------------------------------------

describe('deleteAiCredentials', () => {
  it('sends DELETE to /ai/credentials/:provider', async () => {
    let capturedUrl = '';

    server.use(
      http.delete('*/api/ai/credentials/:provider', ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await deleteAiCredentials('openai');

    expect(capturedUrl).toContain('/ai/credentials/openai');
  });

  it('resolves to undefined (void) on success', async () => {
    server.use(
      http.delete('*/api/ai/credentials/:provider', () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const result = await deleteAiCredentials('anthropic');

    expect(result).toBeUndefined();
  });

  it('propagates ApiError on 404', async () => {
    server.use(
      http.delete('*/api/ai/credentials/:provider', () => {
        return HttpResponse.json({ message: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
      }),
    );

    await expect(deleteAiCredentials('nonexistent')).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// testAiProvider
// ---------------------------------------------------------------------------

describe('testAiProvider', () => {
  it('sends POST to /ai/test with provider and model', async () => {
    let capturedBody: unknown = null;

    server.use(
      http.post('*/api/ai/test', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ data: { ok: true } });
      }),
    );

    await testAiProvider({ provider: 'openai', model: 'gpt-4o' });

    expect(capturedBody).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('returns ok:true when test passes', async () => {
    server.use(
      http.post('*/api/ai/test', () => {
        return HttpResponse.json({ data: { ok: true } });
      }),
    );

    const result = await testAiProvider({ provider: 'openai', model: 'gpt-4o' });

    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false with error message when test fails', async () => {
    server.use(
      http.post('*/api/ai/test', () => {
        return HttpResponse.json({ data: { ok: false, error: 'Invalid API key' } });
      }),
    );

    const result = await testAiProvider({ provider: 'openai', model: 'gpt-4o' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it('propagates ApiError on 403', async () => {
    server.use(
      http.post('*/api/ai/test', () => {
        return HttpResponse.json({ message: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 });
      }),
    );

    await expect(testAiProvider({ provider: 'openai', model: 'gpt-4o' })).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// getAiModels
// ---------------------------------------------------------------------------

describe('getAiModels', () => {
  it('sends GET to /ai/models with provider query param', async () => {
    let capturedUrl = '';

    server.use(
      http.get('*/api/ai/models', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: ['gpt-4o', 'gpt-4'] });
      }),
    );

    await getAiModels('openai');

    expect(capturedUrl).toContain('/ai/models');
    expect(capturedUrl).toContain('provider=openai');
  });

  it('returns the array of model names', async () => {
    server.use(
      http.get('*/api/ai/models', () => {
        return HttpResponse.json({ data: ['gpt-4o', 'gpt-4', 'gpt-3.5-turbo'] });
      }),
    );

    const models = await getAiModels('openai');

    expect(models).toEqual(['gpt-4o', 'gpt-4', 'gpt-3.5-turbo']);
  });

  it('URL-encodes the provider name', async () => {
    let capturedUrl = '';

    server.use(
      http.get('*/api/ai/models', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: [] });
      }),
    );

    await getAiModels('my provider');

    expect(capturedUrl).toContain('provider=my%20provider');
  });

  it('returns an empty array when no models available', async () => {
    server.use(
      http.get('*/api/ai/models', () => {
        return HttpResponse.json({ data: [] });
      }),
    );

    const models = await getAiModels('anthropic');

    expect(models).toEqual([]);
  });

  it('propagates ApiError on 401', async () => {
    server.use(
      http.get('*/api/ai/models', () => {
        return HttpResponse.json({ message: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
      }),
    );

    // Prevent the retry logic from kicking in by using a separate token setup
    api.setAccessToken(null);

    await expect(getAiModels('openai')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// putAiSearchFeature
// ---------------------------------------------------------------------------

describe('putAiSearchFeature', () => {
  it('sends PUT to /ai/features/search with provider and model', async () => {
    let capturedBody: unknown = null;
    let capturedUrl = '';

    server.use(
      http.put('*/api/ai/features/search', async ({ request }) => {
        capturedBody = await request.json();
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await putAiSearchFeature({ provider: 'openai', model: 'gpt-4o' });

    expect(capturedUrl).toContain('/ai/features/search');
    expect(capturedBody).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('resolves to undefined (void) on success', async () => {
    server.use(
      http.put('*/api/ai/features/search', () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const result = await putAiSearchFeature({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' });

    expect(result).toBeUndefined();
  });

  it('propagates ApiError on 400', async () => {
    server.use(
      http.put('*/api/ai/features/search', () => {
        return HttpResponse.json({ message: 'Provider not configured', code: 'BAD_REQUEST' }, { status: 400 });
      }),
    );

    await expect(putAiSearchFeature({ provider: 'openai', model: '' })).rejects.toThrow(ApiError);
  });
});

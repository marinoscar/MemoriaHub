/**
 * Unit tests for tagging service functions.
 *
 * Uses MSW to intercept HTTP requests so the real `api` singleton is exercised.
 * Covers: rerunMediaTags, getMediaTagStatus, runTaggingBackfill,
 *         getCircleTaggingSettings, updateCircleTaggingSettings.
 *
 * Note: runs with Vitest + MSW (container-only deps). If Vitest is not
 * available locally these tests pass inside the container.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  rerunMediaTags,
  getMediaTagStatus,
  runTaggingBackfill,
  getCircleTaggingSettings,
  updateCircleTaggingSettings,
} from '../../services/tagging';
import { api, ApiError } from '../../services/api';

beforeEach(() => {
  api.setAccessToken('test-token');
});
afterEach(() => {
  api.setAccessToken(null);
});

// ---------------------------------------------------------------------------
// rerunMediaTags
// ---------------------------------------------------------------------------

describe('rerunMediaTags', () => {
  it('returns jobId and status on success', async () => {
    server.use(
      http.post('*/api/media/:id/tags/rerun', () =>
        HttpResponse.json({ data: { jobId: 'job-1', status: 'pending' } }),
      ),
    );

    const result = await rerunMediaTags('media-1');

    expect(result.jobId).toBe('job-1');
    expect(result.status).toBe('pending');
  });

  it('sends a POST to /media/:id/tags/rerun', async () => {
    let capturedUrl = '';
    server.use(
      http.post('*/api/media/:id/tags/rerun', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: { jobId: 'job-1', status: 'pending' } });
      }),
    );

    await rerunMediaTags('media-abc');

    expect(capturedUrl).toContain('/media/media-abc/tags/rerun');
  });

  it('throws ApiError on 403', async () => {
    server.use(
      http.post('*/api/media/:id/tags/rerun', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'Not allowed' },
          { status: 403 },
        ),
      ),
    );

    await expect(rerunMediaTags('media-1')).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// getMediaTagStatus
// ---------------------------------------------------------------------------

describe('getMediaTagStatus', () => {
  const mockStatus = {
    status: 'processed' as const,
    providerKey: 'openai',
    modelVersion: 'gpt-4o',
    tagCount: 3,
    processedAt: '2026-01-01T00:00:00Z',
    lastError: null,
  };

  it('returns the tag status on success', async () => {
    server.use(
      http.get('*/api/media/:id/tags/status', () =>
        HttpResponse.json({ data: mockStatus }),
      ),
    );

    const result = await getMediaTagStatus('media-1');

    expect(result).toEqual(mockStatus);
  });

  it('sends a GET to /media/:id/tags/status', async () => {
    let capturedUrl = '';
    server.use(
      http.get('*/api/media/:id/tags/status', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: mockStatus });
      }),
    );

    await getMediaTagStatus('media-xyz');

    expect(capturedUrl).toContain('/media/media-xyz/tags/status');
  });

  it('throws ApiError on 404', async () => {
    server.use(
      http.get('*/api/media/:id/tags/status', () =>
        HttpResponse.json(
          { code: 'NOT_FOUND', message: 'Not found' },
          { status: 404 },
        ),
      ),
    );

    await expect(getMediaTagStatus('missing')).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// runTaggingBackfill
// ---------------------------------------------------------------------------

describe('runTaggingBackfill', () => {
  it('returns enqueued count on success', async () => {
    server.use(
      http.post('*/api/tagging/backfill', () =>
        HttpResponse.json({ data: { enqueued: 5 } }),
      ),
    );

    const result = await runTaggingBackfill({ circleId: 'circle-1' });

    expect(result.enqueued).toBe(5);
  });

  it('sends circleId in request body', async () => {
    let capturedBody: any = null;
    server.use(
      http.post('*/api/tagging/backfill', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ data: { enqueued: 0 } });
      }),
    );

    await runTaggingBackfill({ circleId: 'circle-42' });

    expect(capturedBody.circleId).toBe('circle-42');
  });

  it('sends optional from/to/force params when provided', async () => {
    let capturedBody: any = null;
    server.use(
      http.post('*/api/tagging/backfill', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ data: { enqueued: 3 } });
      }),
    );

    await runTaggingBackfill({
      circleId: 'circle-1',
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
      force: true,
    });

    expect(capturedBody.from).toBe('2026-01-01T00:00:00Z');
    expect(capturedBody.to).toBe('2026-06-01T00:00:00Z');
    expect(capturedBody.force).toBe(true);
  });

  it('throws ApiError on 400 (auto-tagging not enabled)', async () => {
    server.use(
      http.post('*/api/tagging/backfill', () =>
        HttpResponse.json(
          { code: 'BAD_REQUEST', message: 'Auto-tagging not enabled' },
          { status: 400 },
        ),
      ),
    );

    await expect(runTaggingBackfill({ circleId: 'circle-1' })).rejects.toThrow(
      ApiError,
    );
  });
});

// ---------------------------------------------------------------------------
// getCircleTaggingSettings
// ---------------------------------------------------------------------------

describe('getCircleTaggingSettings', () => {
  it('returns autoTaggingEnabled flag', async () => {
    server.use(
      http.get('*/api/circles/:id/tagging-settings', () =>
        HttpResponse.json({ data: { autoTaggingEnabled: true } }),
      ),
    );

    const result = await getCircleTaggingSettings('circle-1');

    expect(result.autoTaggingEnabled).toBe(true);
  });

  it('sends GET to /circles/:id/tagging-settings', async () => {
    let capturedUrl = '';
    server.use(
      http.get('*/api/circles/:id/tagging-settings', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: { autoTaggingEnabled: false } });
      }),
    );

    await getCircleTaggingSettings('circle-99');

    expect(capturedUrl).toContain('/circles/circle-99/tagging-settings');
  });
});

// ---------------------------------------------------------------------------
// updateCircleTaggingSettings
// ---------------------------------------------------------------------------

describe('updateCircleTaggingSettings', () => {
  it('returns updated autoTaggingEnabled flag', async () => {
    server.use(
      http.put('*/api/circles/:id/tagging-settings', () =>
        HttpResponse.json({ data: { autoTaggingEnabled: true } }),
      ),
    );

    const result = await updateCircleTaggingSettings('circle-1', true);

    expect(result.autoTaggingEnabled).toBe(true);
  });

  it('sends enabled=true in request body when enabling', async () => {
    let capturedBody: any = null;
    server.use(
      http.put('*/api/circles/:id/tagging-settings', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ data: { autoTaggingEnabled: true } });
      }),
    );

    await updateCircleTaggingSettings('circle-1', true);

    expect(capturedBody.enabled).toBe(true);
  });

  it('sends enabled=false in request body when disabling', async () => {
    let capturedBody: any = null;
    server.use(
      http.put('*/api/circles/:id/tagging-settings', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ data: { autoTaggingEnabled: false } });
      }),
    );

    await updateCircleTaggingSettings('circle-1', false);

    expect(capturedBody.enabled).toBe(false);
  });
});

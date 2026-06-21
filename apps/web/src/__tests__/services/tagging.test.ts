/**
 * Unit tests for tagging service functions.
 *
 * Uses MSW to intercept HTTP requests so the real `api` singleton is exercised.
 * Covers: rerunMediaTags, getMediaTagStatus.
 *
 * Note: runTaggingBackfill, getCircleTaggingSettings, and
 * updateCircleTaggingSettings were removed in the settings refactor. Per-circle
 * tagging opt-in is now a global admin feature toggle (useSystemSettings), and
 * backfill is a global admin operation via services/adminBackfill.ts.
 *
 * Note: runs with Vitest + MSW (container-only deps). If Vitest is not
 * available locally these tests pass inside the container.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  rerunMediaTags,
  getMediaTagStatus,
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


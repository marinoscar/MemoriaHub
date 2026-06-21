/**
 * Unit tests for metadata service functions.
 *
 * Uses MSW to intercept HTTP requests so the real `api` singleton is exercised.
 * Covers: rerunMediaMetadata, getMediaMetadataStatus, runMetadataBackfill.
 *
 * Note: runs with Vitest + MSW (container-only deps). If Vitest is not
 * available locally these tests pass inside the container.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  rerunMediaMetadata,
  getMediaMetadataStatus,
  runMetadataBackfill,
} from '../../services/metadata';
import { api, ApiError } from '../../services/api';

beforeEach(() => {
  api.setAccessToken('test-token');
});
afterEach(() => {
  api.setAccessToken(null);
});

// ---------------------------------------------------------------------------
// rerunMediaMetadata
// ---------------------------------------------------------------------------

describe('rerunMediaMetadata', () => {
  it('returns { jobId, status } on success', async () => {
    server.use(
      http.post('*/api/media/:id/metadata/rerun', () =>
        HttpResponse.json({ data: { jobId: 'job-1', status: 'pending' } }),
      ),
    );

    const result = await rerunMediaMetadata('media-1');

    expect(result.jobId).toBe('job-1');
    expect(result.status).toBe('pending');
  });

  it('sends POST to /media/:id/metadata/rerun', async () => {
    let capturedUrl = '';
    server.use(
      http.post('*/api/media/:id/metadata/rerun', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: { jobId: 'job-1', status: 'pending' } });
      }),
    );

    await rerunMediaMetadata('media-abc');

    expect(capturedUrl).toContain('/media/media-abc/metadata/rerun');
  });

  it('throws ApiError on 403', async () => {
    server.use(
      http.post('*/api/media/:id/metadata/rerun', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'Not allowed' },
          { status: 403 },
        ),
      ),
    );

    await expect(rerunMediaMetadata('media-1')).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// getMediaMetadataStatus
// ---------------------------------------------------------------------------

describe('getMediaMetadataStatus', () => {
  const mockStatus = {
    status: 'processed' as const,
    processedAt: '2026-01-01T00:00:00Z',
    lastError: null,
  };

  it('returns the status DTO on success', async () => {
    server.use(
      http.get('*/api/media/:id/metadata/status', () =>
        HttpResponse.json({ data: mockStatus }),
      ),
    );

    const result = await getMediaMetadataStatus('media-1');

    expect(result).toEqual(mockStatus);
  });

  it('sends GET to /media/:id/metadata/status', async () => {
    let capturedUrl = '';
    server.use(
      http.get('*/api/media/:id/metadata/status', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: mockStatus });
      }),
    );

    await getMediaMetadataStatus('media-xyz');

    expect(capturedUrl).toContain('/media/media-xyz/metadata/status');
  });

  it('throws ApiError on 404', async () => {
    server.use(
      http.get('*/api/media/:id/metadata/status', () =>
        HttpResponse.json(
          { code: 'NOT_FOUND', message: 'Not found' },
          { status: 404 },
        ),
      ),
    );

    await expect(getMediaMetadataStatus('missing')).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// runMetadataBackfill
// ---------------------------------------------------------------------------

describe('runMetadataBackfill', () => {
  it('returns { enqueued: 3 } on success', async () => {
    server.use(
      http.post('*/api/metadata/backfill', () =>
        HttpResponse.json({ data: { enqueued: 3 } }),
      ),
    );

    const result = await runMetadataBackfill('circle-1');

    expect(result.enqueued).toBe(3);
  });

  it('sends circleId in request body', async () => {
    let capturedBody: any = null;
    server.use(
      http.post('*/api/metadata/backfill', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ data: { enqueued: 0 } });
      }),
    );

    await runMetadataBackfill('circle-42');

    expect(capturedBody.circleId).toBe('circle-42');
  });

  it('sends optional from, to, force params when provided', async () => {
    let capturedBody: any = null;
    server.use(
      http.post('*/api/metadata/backfill', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ data: { enqueued: 1 } });
      }),
    );

    await runMetadataBackfill('circle-1', {
      from: '2020-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
      force: true,
    });

    expect(capturedBody.from).toBe('2020-01-01T00:00:00Z');
    expect(capturedBody.to).toBe('2026-06-01T00:00:00Z');
    expect(capturedBody.force).toBe(true);
  });

  it('throws ApiError on 400', async () => {
    server.use(
      http.post('*/api/metadata/backfill', () =>
        HttpResponse.json(
          { code: 'BAD_REQUEST', message: 'Bad request' },
          { status: 400 },
        ),
      ),
    );

    await expect(runMetadataBackfill('circle-1')).rejects.toThrow(ApiError);
  });
});

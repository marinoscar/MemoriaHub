/**
 * Unit tests for the per-item tagging clients: rerunMediaTags, getMediaTagStatus.
 *
 * The clients call the active host's API client, so the fake host records the
 * requests and answers the routes the cases declare.
 *
 * Note: runTaggingBackfill, getCircleTaggingSettings, and updateCircleTaggingSettings
 * were removed in the settings refactor. Per-circle tagging opt-in is now a global
 * admin feature toggle, and backfill is a global admin operation.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { MemoriahubApiError } from '../../src/core/headless/api.js';
import { setActiveMemoriahubHost } from '../../src/core/headless/host.js';
import { createFakeMemoriahubWebHost, fakeApiError } from '../../src/core/testing/fake-host.js';
import type { FakeMemoriahubWebHost } from '../../src/core/testing/fake-host.js';
import { getMediaTagStatus, rerunMediaTags } from '../../src/tagging/headless/services/tagging.js';

let fake: FakeMemoriahubWebHost;

function install(routes: Parameters<typeof createFakeMemoriahubWebHost>[0] = {}) {
  fake = createFakeMemoriahubWebHost(routes);
  setActiveMemoriahubHost(fake.host);
}

afterEach(() => setActiveMemoriahubHost(null));

describe('rerunMediaTags', () => {
  it('returns jobId and status on success', async () => {
    install({ routes: { 'POST /media/:id/tags/rerun': { jobId: 'job-1', status: 'pending' } } });

    const result = await rerunMediaTags('media-1');

    expect(result.jobId).toBe('job-1');
    expect(result.status).toBe('pending');
  });

  it('sends a POST to /media/:id/tags/rerun', async () => {
    install({ routes: { 'POST /media/:id/tags/rerun': { jobId: 'job-1', status: 'pending' } } });

    await rerunMediaTags('media-abc');

    expect(fake.calls[0].method).toBe('POST');
    expect(fake.calls[0].path).toBe('/media/media-abc/tags/rerun');
  });

  it('rejects with the API error on 403', async () => {
    install({
      routes: {
        'POST /media/:id/tags/rerun': () => {
          throw fakeApiError(403, 'Not allowed', 'FORBIDDEN');
        },
      },
    });

    await expect(rerunMediaTags('media-1')).rejects.toThrow(MemoriahubApiError);
  });
});

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
    install({ routes: { 'GET /media/:id/tags/status': mockStatus } });

    expect(await getMediaTagStatus('media-1')).toEqual(mockStatus);
  });

  it('sends a GET to /media/:id/tags/status', async () => {
    install({ routes: { 'GET /media/:id/tags/status': mockStatus } });

    await getMediaTagStatus('media-xyz');

    expect(fake.calls[0].method).toBe('GET');
    expect(fake.calls[0].path).toBe('/media/media-xyz/tags/status');
  });

  it('rejects with the API error on 404', async () => {
    install({
      routes: {
        'GET /media/:id/tags/status': () => {
          throw fakeApiError(404, 'Not found', 'NOT_FOUND');
        },
      },
    });

    await expect(getMediaTagStatus('missing')).rejects.toThrow(MemoriahubApiError);
  });
});

/**
 * Unit tests for tagLabels service functions.
 *
 * Uses MSW to intercept HTTP requests. Covers:
 * listTagLabels, createTagLabel, updateTagLabel, deleteTagLabel.
 *
 * Note: runs with Vitest + MSW (container-only deps). If Vitest is not
 * available locally these tests pass inside the container.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  listTagLabels,
  createTagLabel,
  updateTagLabel,
  deleteTagLabel,
  type TagLabel,
} from '../../services/tagLabels';
import { api, ApiError } from '../../services/api';

beforeEach(() => {
  api.setAccessToken('test-token');
});
afterEach(() => {
  api.setAccessToken(null);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTagLabel(overrides: Partial<TagLabel> = {}): TagLabel {
  return {
    id: 'label-1',
    name: 'Beach',
    description: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// listTagLabels
// ---------------------------------------------------------------------------

describe('listTagLabels', () => {
  it('returns array of tag labels on success', async () => {
    const labels = [
      makeTagLabel({ id: 'label-1', name: 'Beach' }),
      makeTagLabel({ id: 'label-2', name: 'Sunset' }),
    ];

    server.use(
      http.get('*/api/tag-labels', () =>
        HttpResponse.json({ data: labels }),
      ),
    );

    const result = await listTagLabels();

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Beach');
    expect(result[1].name).toBe('Sunset');
  });

  it('returns empty array when no labels exist', async () => {
    server.use(
      http.get('*/api/tag-labels', () =>
        HttpResponse.json({ data: [] }),
      ),
    );

    const result = await listTagLabels();

    expect(result).toEqual([]);
  });

  it('throws ApiError on 401', async () => {
    server.use(
      http.get('*/api/tag-labels', () =>
        HttpResponse.json(
          { code: 'UNAUTHORIZED', message: 'Unauthorized' },
          { status: 401 },
        ),
      ),
    );

    await expect(listTagLabels()).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// createTagLabel
// ---------------------------------------------------------------------------

describe('createTagLabel', () => {
  it('returns the created tag label on success', async () => {
    const newLabel = makeTagLabel({ id: 'label-new', name: 'Mountain' });

    server.use(
      http.post('*/api/tag-labels', () =>
        HttpResponse.json({ data: newLabel }, { status: 201 }),
      ),
    );

    const result = await createTagLabel({ name: 'Mountain' });

    expect(result).toEqual(newLabel);
  });

  it('sends name and description in request body', async () => {
    let capturedBody: any = null;

    server.use(
      http.post('*/api/tag-labels', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ data: makeTagLabel() }, { status: 201 });
      }),
    );

    await createTagLabel({ name: 'Forest', description: 'Dense trees' });

    expect(capturedBody.name).toBe('Forest');
    expect(capturedBody.description).toBe('Dense trees');
  });

  it('throws ApiError on 409 (duplicate name)', async () => {
    server.use(
      http.post('*/api/tag-labels', () =>
        HttpResponse.json(
          { code: 'CONFLICT', message: 'Tag label already exists' },
          { status: 409 },
        ),
      ),
    );

    await expect(createTagLabel({ name: 'Beach' })).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// updateTagLabel
// ---------------------------------------------------------------------------

describe('updateTagLabel', () => {
  it('returns updated tag label on success', async () => {
    const updated = makeTagLabel({ name: 'Sunrise', enabled: false });

    server.use(
      http.patch('*/api/tag-labels/:id', () =>
        HttpResponse.json({ data: updated }),
      ),
    );

    const result = await updateTagLabel('label-1', { name: 'Sunrise', enabled: false });

    expect(result.name).toBe('Sunrise');
    expect(result.enabled).toBe(false);
  });

  it('sends only the fields included in the update body', async () => {
    let capturedBody: any = null;

    server.use(
      http.patch('*/api/tag-labels/:id', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ data: makeTagLabel() });
      }),
    );

    await updateTagLabel('label-1', { enabled: false });

    expect(capturedBody).toEqual({ enabled: false });
    expect(capturedBody.name).toBeUndefined();
  });

  it('targets the correct label id in the URL', async () => {
    let capturedUrl = '';

    server.use(
      http.patch('*/api/tag-labels/:id', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: makeTagLabel() });
      }),
    );

    await updateTagLabel('label-abc', { name: 'New Name' });

    expect(capturedUrl).toContain('/tag-labels/label-abc');
  });

  it('throws ApiError on 404 (label not found)', async () => {
    server.use(
      http.patch('*/api/tag-labels/:id', () =>
        HttpResponse.json(
          { code: 'NOT_FOUND', message: 'Not found' },
          { status: 404 },
        ),
      ),
    );

    await expect(updateTagLabel('missing', { name: 'X' })).rejects.toThrow(ApiError);
  });

  it('throws ApiError on 409 (name conflict on rename)', async () => {
    server.use(
      http.patch('*/api/tag-labels/:id', () =>
        HttpResponse.json(
          { code: 'CONFLICT', message: 'Name already taken' },
          { status: 409 },
        ),
      ),
    );

    await expect(updateTagLabel('label-1', { name: 'Beach' })).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// deleteTagLabel
// ---------------------------------------------------------------------------

describe('deleteTagLabel', () => {
  it('resolves without a value on 204', async () => {
    server.use(
      http.delete('*/api/tag-labels/:id', () => new HttpResponse(null, { status: 204 })),
    );

    await expect(deleteTagLabel('label-1')).resolves.toBeUndefined();
  });

  it('targets the correct label id in the URL', async () => {
    let capturedUrl = '';

    server.use(
      http.delete('*/api/tag-labels/:id', ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await deleteTagLabel('label-xyz');

    expect(capturedUrl).toContain('/tag-labels/label-xyz');
  });

  it('throws ApiError on 404 (label not found)', async () => {
    server.use(
      http.delete('*/api/tag-labels/:id', () =>
        HttpResponse.json(
          { code: 'NOT_FOUND', message: 'Not found' },
          { status: 404 },
        ),
      ),
    );

    await expect(deleteTagLabel('missing')).rejects.toThrow(ApiError);
  });
});

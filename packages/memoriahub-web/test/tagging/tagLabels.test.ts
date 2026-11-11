/**
 * Unit tests for the tag vocabulary clients: listTagLabels, createTagLabel,
 * updateTagLabel, deleteTagLabel.
 *
 * The clients call the active host's API client; the fake host records the
 * requests and answers the routes the cases declare.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { MemoriahubApiError } from '../../src/core/headless/api.js';
import { setActiveMemoriahubHost } from '../../src/core/headless/host.js';
import { createFakeMemoriahubWebHost, fakeApiError } from '../../src/core/testing/fake-host.js';
import type { FakeMemoriahubWebHost } from '../../src/core/testing/fake-host.js';
import {
  createTagLabel,
  deleteTagLabel,
  listTagLabels,
  updateTagLabel,
} from '../../src/tagging/headless/services/tagLabels.js';
import type { TagLabel } from '../../src/tagging/headless/services/tagLabels.js';

let fake: FakeMemoriahubWebHost;

function install(routes: Parameters<typeof createFakeMemoriahubWebHost>[0] = {}) {
  fake = createFakeMemoriahubWebHost(routes);
  setActiveMemoriahubHost(fake.host);
}

afterEach(() => setActiveMemoriahubHost(null));

function failing(status: number, message: string, code: string) {
  return () => {
    throw fakeApiError(status, message, code);
  };
}

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

describe('listTagLabels', () => {
  it('returns array of tag labels on success', async () => {
    install({
      routes: {
        'GET /tag-labels': [
          makeTagLabel({ id: 'label-1', name: 'Beach' }),
          makeTagLabel({ id: 'label-2', name: 'Sunset' }),
        ],
      },
    });

    const result = await listTagLabels();

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Beach');
    expect(result[1].name).toBe('Sunset');
  });

  it('returns empty array when no labels exist', async () => {
    install({ routes: { 'GET /tag-labels': [] } });

    expect(await listTagLabels()).toEqual([]);
  });

  it('rejects with the API error on 401', async () => {
    install({ routes: { 'GET /tag-labels': failing(401, 'Unauthorized', 'UNAUTHORIZED') } });

    await expect(listTagLabels()).rejects.toThrow(MemoriahubApiError);
  });
});

describe('createTagLabel', () => {
  it('returns the created tag label on success', async () => {
    const newLabel = makeTagLabel({ id: 'label-new', name: 'Mountain' });
    install({ routes: { 'POST /tag-labels': newLabel } });

    expect(await createTagLabel({ name: 'Mountain' })).toEqual(newLabel);
  });

  it('sends name and description in request body', async () => {
    install({ routes: { 'POST /tag-labels': makeTagLabel() } });

    await createTagLabel({ name: 'Forest', description: 'Dense trees' });

    expect(fake.calls[0].body).toMatchObject({ name: 'Forest', description: 'Dense trees' });
  });

  it('rejects with the API error on 409 (duplicate name)', async () => {
    install({ routes: { 'POST /tag-labels': failing(409, 'Tag label already exists', 'CONFLICT') } });

    await expect(createTagLabel({ name: 'Beach' })).rejects.toThrow(MemoriahubApiError);
  });
});

describe('updateTagLabel', () => {
  it('returns updated tag label on success', async () => {
    install({ routes: { 'PATCH /tag-labels/:id': makeTagLabel({ name: 'Sunrise', enabled: false }) } });

    const result = await updateTagLabel('label-1', { name: 'Sunrise', enabled: false });

    expect(result.name).toBe('Sunrise');
    expect(result.enabled).toBe(false);
  });

  it('sends only the fields included in the update body', async () => {
    install({ routes: { 'PATCH /tag-labels/:id': makeTagLabel() } });

    await updateTagLabel('label-1', { enabled: false });

    expect(fake.calls[0].body).toEqual({ enabled: false });
  });

  it('targets the correct label id in the URL', async () => {
    install({ routes: { 'PATCH /tag-labels/:id': makeTagLabel() } });

    await updateTagLabel('label-abc', { name: 'New Name' });

    expect(fake.calls[0].path).toBe('/tag-labels/label-abc');
  });

  it('rejects with the API error on 404 (label not found)', async () => {
    install({ routes: { 'PATCH /tag-labels/:id': failing(404, 'Not found', 'NOT_FOUND') } });

    await expect(updateTagLabel('missing', { name: 'X' })).rejects.toThrow(MemoriahubApiError);
  });

  it('rejects with the API error on 409 (name conflict on rename)', async () => {
    install({ routes: { 'PATCH /tag-labels/:id': failing(409, 'Name already taken', 'CONFLICT') } });

    await expect(updateTagLabel('label-1', { name: 'Beach' })).rejects.toThrow(MemoriahubApiError);
  });
});

describe('deleteTagLabel', () => {
  it('resolves without a value on 204', async () => {
    install({ routes: { 'DELETE /tag-labels/:id': null } });

    await expect(deleteTagLabel('label-1')).resolves.toBeUndefined();
  });

  it('targets the correct label id in the URL', async () => {
    install({ routes: { 'DELETE /tag-labels/:id': null } });

    await deleteTagLabel('label-xyz');

    expect(fake.calls[0].method).toBe('DELETE');
    expect(fake.calls[0].path).toBe('/tag-labels/label-xyz');
  });

  it('rejects with the API error on 404 (label not found)', async () => {
    install({ routes: { 'DELETE /tag-labels/:id': failing(404, 'Not found', 'NOT_FOUND') } });

    await expect(deleteTagLabel('missing')).rejects.toThrow(MemoriahubApiError);
  });
});

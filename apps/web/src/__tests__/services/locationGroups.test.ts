/**
 * Unit tests for `services/locationGroups` — the Location Grouping management
 * API client (epic #373, admin page in issue #375).
 *
 * Uses MSW to intercept the real fetch calls the `api` singleton makes, so what
 * is asserted is the URL/body actually put on the wire, not a mock's arguments
 * (same approach as `services/memories.test.ts`).
 *
 * The load-bearing case here is `extractLocationGroupConflict`: the API reports
 * the owning group at **`details.groupName`**, because `HttpExceptionFilter`
 * rebuilds every error body from a fixed key allowlist and silently drops a
 * top-level custom field. A client reading a top-level `groupName` would
 * compile, pass a naive mock-based test, and always render `undefined`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { api, ApiError } from '../../services/api';
import {
  addLocationGroupMembers,
  createLocationGroup,
  deleteLocationGroup,
  extractLocationGroupConflict,
  getLocationGroup,
  listLocationGroupSuggestions,
  listLocationGroups,
  listLocationValues,
  locationGroupErrorMessage,
  rebuildLocationGroups,
  removeLocationGroupMembers,
  updateLocationGroup,
} from '../../services/locationGroups';

const BASE = 'http://localhost:3000/api';

beforeEach(() => {
  api.setAccessToken('test-token');
});
afterEach(() => {
  api.setAccessToken(null);
});

/** Capture the request URL/method/body an endpoint is called with. */
function capture(path: string, body: unknown = { items: [], meta: {} }, status = 200) {
  const seen: { url: URL | null; method: string | null; body: unknown } = {
    url: null,
    method: null,
    body: undefined,
  };
  server.use(
    http.all(`${BASE}${path}`, async ({ request }) => {
      seen.url = new URL(request.url);
      seen.method = request.method;
      seen.body = await request.text().then((t) => (t ? JSON.parse(t) : undefined));
      if (status === 204) return new HttpResponse(null, { status: 204 });
      return HttpResponse.json({ data: body }, { status });
    }),
  );
  return seen;
}

describe('services/locationGroups', () => {
  // -------------------------------------------------------------------------
  describe('listLocationGroups', () => {
    it('omits every unset filter', async () => {
      const seen = capture('/location-groups', { items: [], meta: { total: 0, page: 1, pageSize: 50 } });

      await listLocationGroups();

      expect(seen.url?.pathname).toBe('/api/location-groups');
      expect(seen.url?.search).toBe('');
    });

    it('sends level, enabled, q, page and pageSize', async () => {
      const seen = capture('/location-groups', { items: [], meta: { total: 0, page: 2, pageSize: 10 } });

      await listLocationGroups({ level: 'locality', enabled: false, q: 'Heredia', page: 2, pageSize: 10 });

      expect(seen.url?.searchParams.get('level')).toBe('locality');
      expect(seen.url?.searchParams.get('enabled')).toBe('false');
      expect(seen.url?.searchParams.get('q')).toBe('Heredia');
      expect(seen.url?.searchParams.get('page')).toBe('2');
      expect(seen.url?.searchParams.get('pageSize')).toBe('10');
    });

    it('never sends a blank q (the API requires min length 1)', async () => {
      const seen = capture('/location-groups', { items: [], meta: { total: 0, page: 1, pageSize: 50 } });

      await listLocationGroups({ level: 'region', q: '   ' });

      expect(seen.url?.searchParams.has('q')).toBe(false);
    });

    it('unwraps the { data: { items, meta } } envelope', async () => {
      capture('/location-groups', {
        items: [{ id: 'g1', canonicalName: 'Heredia' }],
        meta: { total: 1, page: 1, pageSize: 50 },
      });

      const res = await listLocationGroups({ level: 'locality' });

      expect(res.items).toHaveLength(1);
      expect(res.meta.total).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('values and suggestions', () => {
    it('listLocationValues always sends level and forwards grouped/limit', async () => {
      const seen = capture('/location-groups/values', { items: [], meta: { total: 0, limit: 50 } });

      await listLocationValues({ level: 'region', q: 'her', grouped: 'ungrouped', limit: 50 });

      expect(seen.url?.searchParams.get('level')).toBe('region');
      expect(seen.url?.searchParams.get('q')).toBe('her');
      expect(seen.url?.searchParams.get('grouped')).toBe('ungrouped');
      expect(seen.url?.searchParams.get('limit')).toBe('50');
    });

    it('listLocationGroupSuggestions sends level and limit', async () => {
      const seen = capture('/location-groups/suggestions', { items: [], meta: { total: 0, limit: 25 } });

      await listLocationGroupSuggestions({ level: 'locality', limit: 25 });

      expect(seen.url?.searchParams.get('level')).toBe('locality');
      expect(seen.url?.searchParams.get('limit')).toBe('25');
    });
  });

  // -------------------------------------------------------------------------
  describe('mutations', () => {
    it('createLocationGroup POSTs the body', async () => {
      const seen = capture('/location-groups', { id: 'g1' });

      await createLocationGroup({
        level: 'locality',
        canonicalName: 'Heredia',
        countryCode: 'CR',
        memberValues: ['Provincia de Heredia'],
      });

      expect(seen.method).toBe('POST');
      expect(seen.body).toEqual({
        level: 'locality',
        canonicalName: 'Heredia',
        countryCode: 'CR',
        memberValues: ['Provincia de Heredia'],
      });
    });

    it('updateLocationGroup PATCHes the body', async () => {
      const seen = capture('/location-groups/g1', { id: 'g1' });

      await updateLocationGroup('g1', { enabled: false });

      expect(seen.method).toBe('PATCH');
      expect(seen.body).toEqual({ enabled: false });
    });

    it('deleteLocationGroup DELETEs and tolerates a 204', async () => {
      const seen = capture('/location-groups/g1', undefined, 204);

      await expect(deleteLocationGroup('g1')).resolves.toBeUndefined();
      expect(seen.method).toBe('DELETE');
    });

    it('addLocationGroupMembers POSTs { values }', async () => {
      const seen = capture('/location-groups/g1/members', { added: 1 });

      const res = await addLocationGroupMembers('g1', ['Heredia Province']);

      expect(seen.method).toBe('POST');
      expect(seen.body).toEqual({ values: ['Heredia Province'] });
      expect(res.added).toBe(1);
    });

    it('removeLocationGroupMembers DELETEs WITH a { values } body', async () => {
      const seen = capture('/location-groups/g1/members', { removed: 1 });

      const res = await removeLocationGroupMembers('g1', ['Heredia Province']);

      expect(seen.method).toBe('DELETE');
      expect(seen.body).toEqual({ values: ['Heredia Province'] });
      expect(res.removed).toBe(1);
    });

    it('rebuildLocationGroups POSTs to the admin route and unwraps { jobId, status }', async () => {
      const seen = capture('/admin/location-groups/rebuild', { jobId: 'job-1', status: 'pending' });

      const res = await rebuildLocationGroups();

      expect(seen.method).toBe('POST');
      expect(seen.url?.pathname).toBe('/api/admin/location-groups/rebuild');
      expect(res).toEqual({ jobId: 'job-1', status: 'pending' });
    });

    it('getLocationGroup returns the alias list', async () => {
      capture('/location-groups/g1', {
        id: 'g1',
        canonicalName: 'Heredia',
        aliases: [{ id: 'a1', rawValue: 'Provincia de Heredia', itemCount: 12 }],
      });

      const res = await getLocationGroup('g1');

      expect(res.aliases[0].rawValue).toBe('Provincia de Heredia');
    });
  });

  // -------------------------------------------------------------------------
  describe('409 member conflict', () => {
    it('reads the owning group from details.groupName, not a top-level field', () => {
      const err = new ApiError(
        '"heredia" is already a member of "Heredia"',
        409,
        'LOCATION_GROUP_MEMBER_CONFLICT',
        { groupId: 'g-owner', groupName: 'Heredia' },
      );

      const conflict = extractLocationGroupConflict(err);

      expect(conflict).toEqual({
        message: '"heredia" is already a member of "Heredia"',
        groupId: 'g-owner',
        groupName: 'Heredia',
      });
    });

    it('returns null groupName when details carries no owner', () => {
      const err = new ApiError('conflict', 409, 'LOCATION_GROUP_MEMBER_CONFLICT', undefined);

      expect(extractLocationGroupConflict(err)).toEqual({
        message: 'conflict',
        groupId: null,
        groupName: null,
      });
    });

    it('returns null for non-409 errors', () => {
      expect(extractLocationGroupConflict(new ApiError('nope', 400))).toBeNull();
      expect(extractLocationGroupConflict(new Error('boom'))).toBeNull();
    });

    it('locationGroupErrorMessage names the owning group', () => {
      const err = new ApiError('"heredia" is already a member of "Heredia"', 409, undefined, {
        groupId: 'g-owner',
        groupName: 'Heredia',
      });

      expect(locationGroupErrorMessage(err)).toContain('Already in group "Heredia"');
    });

    it('locationGroupErrorMessage falls through to the plain message otherwise', () => {
      expect(locationGroupErrorMessage(new Error('Queue unavailable'))).toBe('Queue unavailable');
      expect(locationGroupErrorMessage(null, 'fallback')).toBe('fallback');
    });

    it('surfaces details.groupName end-to-end from a real 409 response body', async () => {
      server.use(
        http.post(`${BASE}/location-groups/g1/members`, () =>
          HttpResponse.json(
            {
              message: '"heredia" is already a member of "Heredia"',
              code: 'LOCATION_GROUP_MEMBER_CONFLICT',
              details: { groupId: 'g-owner', groupName: 'Heredia' },
            },
            { status: 409 },
          ),
        ),
      );

      const err = await addLocationGroupMembers('g1', ['Heredia']).catch((e: unknown) => e);

      expect(locationGroupErrorMessage(err)).toContain('Already in group "Heredia"');
    });
  });
});

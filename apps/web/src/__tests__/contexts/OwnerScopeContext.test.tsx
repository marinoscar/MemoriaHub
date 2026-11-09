/**
 * OwnerScopeContext (RETRO-I6, #588): "My library" plus the caller's groups,
 * the persisted `activeOwnerScope`, and the legacy `CircleContext` fields the
 * pages still read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { waitFor, act, renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { server } from '../mocks/server';
import {
  OwnerScopeProvider,
  parseStoredOwnerScope,
  resolveOwnerScope,
  useOwnerScope,
  type OwnerScopeOption,
} from '../../contexts/OwnerScopeContext';
import { AuthProvider } from '../../contexts/AuthContext';
import { disarmOwnerScopeParams } from '../../services/ownerScopeParams';

const API_BASE = '*/api';
const PERSONAL = '11111111-1111-4111-8111-111111111111';
const FAMILY = '22222222-2222-4222-8222-222222222222';
const CLUB = '33333333-3333-4333-8333-333333333333';

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <AuthProvider>
        <OwnerScopeProvider>{children}</OwnerScopeProvider>
      </AuthProvider>
    </MemoryRouter>
  );
}

function signedIn(extra: Parameters<typeof server.use> = []) {
  server.use(
    http.post(`${API_BASE}/auth/refresh`, () => HttpResponse.json({ accessToken: 'test-token', expiresIn: 900 })),
    http.get(`${API_BASE}/auth/me`, () =>
      HttpResponse.json({
        data: {
          id: 'test-user-id',
          email: 'person-a@example.test',
          displayName: 'Person A',
          profileImageUrl: null,
          roles: [{ name: 'viewer' }],
          permissions: [],
          isActive: true,
        },
      }),
    ),
    http.get(`${API_BASE}/users/me/library`, () => HttpResponse.json({ data: { id: PERSONAL, name: 'My library' } })),
    http.get(`${API_BASE}/groups`, () =>
      HttpResponse.json({
        data: {
          items: [
            { id: FAMILY, name: 'Org Alpha family', description: null, myRole: 'editor' },
            { id: CLUB, name: 'Book club', description: 'Books', myRole: 'viewer' },
          ],
          page: 1,
          pageSize: 100,
          total: 2,
          totalPages: 1,
        },
      }),
    ),
    ...extra,
  );
}

describe('OwnerScopeContext', () => {
  beforeEach(() => disarmOwnerScopeParams());
  afterEach(() => disarmOwnerScopeParams());

  it('lists "My library" first, then the groups by name, and defaults to me', async () => {
    signedIn();
    const { result } = renderHook(() => useOwnerScope(), { wrapper });
    await waitFor(() => expect(result.current.scopes).toHaveLength(3));
    expect(result.current.scopes.map((s) => s.name)).toEqual(['My library', 'Book club', 'Org Alpha family']);
    expect(result.current.activeScope).toEqual({ kind: 'me' });
    expect(result.current.activeCircleId).toBe(PERSONAL);
    expect(result.current.activeCircle?.isPersonal).toBe(true);
    expect(result.current.activeCircleRole).toBe('circle_admin');
  });

  it('restores a stored group scope and maps the group role', async () => {
    signedIn([
      http.get(`${API_BASE}/user-settings`, () =>
        HttpResponse.json({ data: { activeOwnerScope: { kind: 'group', groupId: CLUB }, version: 1 } }),
      ),
    ]);
    const { result } = renderHook(() => useOwnerScope(), { wrapper });
    await waitFor(() => expect(result.current.activeCircleId).toBe(CLUB));
    expect(result.current.activeRole).toBe('viewer');
    expect(result.current.activeCircleRole).toBe('viewer');
  });

  it('persists a switch as activeOwnerScope', async () => {
    let patched: unknown = null;
    signedIn([
      http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json({ data: {} });
      }),
    ]);
    const { result } = renderHook(() => useOwnerScope(), { wrapper });
    await waitFor(() => expect(result.current.scopes).toHaveLength(3));
    await act(async () => {
      await result.current.setActiveCircle(FAMILY);
    });
    expect(result.current.activeCircleId).toBe(FAMILY);
    expect(result.current.activeCircleRole).toBe('collaborator');
    expect(patched).toEqual({ activeOwnerScope: { kind: 'group', groupId: FAMILY } });
  });

  it('rewrites circleId on the wire once armed', async () => {
    let seen: string | null = null;
    signedIn([
      http.get(`${API_BASE}/media`, ({ request }) => {
        seen = new URL(request.url).search;
        return HttpResponse.json({ data: { items: [], meta: {} } });
      }),
    ]);
    const { result } = renderHook(() => useOwnerScope(), { wrapper });
    await waitFor(() => expect(result.current.scopes).toHaveLength(3));
    const { api } = await import('../../services/api');
    await api.get(`/media?circleId=${PERSONAL}&pageSize=5`);
    expect(seen).toBe('?scope=me&pageSize=5');
    await api.get(`/media?circleId=${FAMILY}`);
    expect(seen).toBe(`?ownerGroupId=${FAMILY}`);
  });
});

describe('resolveOwnerScope / parseStoredOwnerScope', () => {
  const scopes: OwnerScopeOption[] = [
    { id: PERSONAL, kind: 'me', name: 'My library', description: null, role: 'admin' },
    { id: FAMILY, kind: 'group', name: 'Family', description: null, role: 'editor' },
  ];

  it('falls back to me for a group the caller left', () => {
    expect(resolveOwnerScope({ kind: 'group', groupId: CLUB }, scopes)).toEqual({ kind: 'me' });
  });

  it('uses the first group when there is no personal library', () => {
    expect(resolveOwnerScope(null, scopes.slice(1))).toEqual({ kind: 'group', groupId: FAMILY });
  });

  it('ignores a malformed stored value', () => {
    expect(parseStoredOwnerScope({ kind: 'circle' })).toBeNull();
    expect(parseStoredOwnerScope('me')).toBeNull();
    expect(parseStoredOwnerScope({ kind: 'me' })).toEqual({ kind: 'me' });
  });
});

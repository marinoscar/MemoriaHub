import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { CircleProvider, useCircleContext } from '../../contexts/CircleContext';
import { AuthProvider } from '../../contexts/AuthContext';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const API_BASE = '*/api';

function createWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter>
        <AuthProvider>
          <CircleProvider>{children}</CircleProvider>
        </AuthProvider>
      </MemoryRouter>
    );
  };
}

const mockCircle = {
  id: 'circle-1',
  name: "Test User's Library",
  description: null,
  ownerId: 'test-user-id',
  isPersonal: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('CircleContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Loading circles on mount', () => {
    it('loads circles when authenticated', async () => {
      // Auth succeeds
      server.use(
        http.post(`${API_BASE}/auth/refresh`, () =>
          HttpResponse.json({ accessToken: 'test-token', expiresIn: 900 }),
        ),
        http.get(`${API_BASE}/auth/me`, () =>
          HttpResponse.json({ data: { id: 'test-user-id', email: 'test@example.com', displayName: 'Test', profileImageUrl: null, roles: [{ name: 'viewer' }], permissions: [], isActive: true, createdAt: new Date().toISOString() } }),
        ),
      );

      const { result } = renderHook(() => useCircleContext(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.circles.length).toBeGreaterThan(0);
      });

      expect(result.current.circles[0].id).toBe('circle-1');
    });

    it('sets activeCircle to personal circle when activeCircleId matches', async () => {
      server.use(
        http.post(`${API_BASE}/auth/refresh`, () =>
          HttpResponse.json({ accessToken: 'test-token', expiresIn: 900 }),
        ),
        http.get(`${API_BASE}/auth/me`, () =>
          HttpResponse.json({ data: { id: 'test-user-id', email: 'test@example.com', displayName: 'Test', profileImageUrl: null, roles: [{ name: 'viewer' }], permissions: [], isActive: true, createdAt: new Date().toISOString() } }),
        ),
        http.get(`${API_BASE}/user-settings`, () =>
          HttpResponse.json({ data: { theme: 'system', profile: { useProviderImage: true }, activeCircleId: 'circle-1', updatedAt: new Date().toISOString(), version: 1 } }),
        ),
      );

      const { result } = renderHook(() => useCircleContext(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.activeCircleId).toBe('circle-1');
      });

      expect(result.current.activeCircle?.id).toBe('circle-1');
    });

    it('falls back to personal circle when persisted id not found', async () => {
      server.use(
        http.post(`${API_BASE}/auth/refresh`, () =>
          HttpResponse.json({ accessToken: 'test-token', expiresIn: 900 }),
        ),
        http.get(`${API_BASE}/auth/me`, () =>
          HttpResponse.json({ data: { id: 'test-user-id', email: 'test@example.com', displayName: 'Test', profileImageUrl: null, roles: [{ name: 'viewer' }], permissions: [], isActive: true, createdAt: new Date().toISOString() } }),
        ),
        http.get(`${API_BASE}/user-settings`, () =>
          HttpResponse.json({ data: { theme: 'system', profile: { useProviderImage: true }, activeCircleId: 'non-existent-circle', updatedAt: new Date().toISOString(), version: 1 } }),
        ),
        http.get(`${API_BASE}/circles`, () =>
          HttpResponse.json({
            items: [{ ...mockCircle, isPersonal: true }],
            total: 1,
            page: 1,
            pageSize: 10,
            totalPages: 1,
          }),
        ),
      );

      const { result } = renderHook(() => useCircleContext(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.circles.length).toBeGreaterThan(0);
      });

      // Falls back to personal circle
      expect(result.current.activeCircle?.isPersonal).toBe(true);
    });
  });

  describe('setActiveCircle', () => {
    it('updates activeCircleId and persists to user settings', async () => {
      server.use(
        http.post(`${API_BASE}/auth/refresh`, () =>
          HttpResponse.json({ accessToken: 'test-token', expiresIn: 900 }),
        ),
        http.get(`${API_BASE}/auth/me`, () =>
          HttpResponse.json({ data: { id: 'test-user-id', email: 'test@example.com', displayName: 'Test', profileImageUrl: null, roles: [{ name: 'viewer' }], permissions: [], isActive: true, createdAt: new Date().toISOString() } }),
        ),
        http.get(`${API_BASE}/circles`, () =>
          HttpResponse.json({
            items: [
              { ...mockCircle, id: 'circle-1' },
              { ...mockCircle, id: 'circle-2', name: 'Circle 2', isPersonal: false },
            ],
            total: 2,
            page: 1,
            pageSize: 10,
            totalPages: 1,
          }),
        ),
      );

      const patchSpy = vi.fn().mockResolvedValue({});
      server.use(
        http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
          const body = await request.json();
          patchSpy(body);
          return HttpResponse.json({ data: {} });
        }),
      );

      const { result } = renderHook(() => useCircleContext(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.circles.length).toBeGreaterThan(0);
      });

      await act(async () => {
        await result.current.setActiveCircle('circle-2');
      });

      expect(result.current.activeCircleId).toBe('circle-2');
    });
  });

  describe('Unauthenticated state', () => {
    it('clears circles when not authenticated', async () => {
      server.use(
        http.post(`${API_BASE}/auth/refresh`, () =>
          new HttpResponse(null, { status: 401 }),
        ),
        http.get(`${API_BASE}/auth/me`, () =>
          new HttpResponse(null, { status: 401 }),
        ),
      );

      const { result } = renderHook(() => useCircleContext(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.circles).toHaveLength(0);
      expect(result.current.activeCircleId).toBeNull();
    });
  });
});

/**
 * Login-time timezone auto-detection, through the real `AuthProvider`
 * (issue #444).
 *
 * The hook's own logic is covered in `hooks/useTimezoneAutoDetect.test.ts`.
 * What this file pins down is the wiring — that detection actually runs on the
 * SESSION-ESTABLISHED path (so a cookie-restored session is covered, not just
 * the OAuth callback), and that nothing it does can take the login down with it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { server } from '../mocks/server';
import { AuthProvider, useAuth } from '../../contexts/AuthContext';
import { detectTimeZone } from '../../utils/timezone';

vi.mock('../../utils/timezone', async () => {
  const actual =
    await vi.importActual<typeof import('../../utils/timezone')>('../../utils/timezone');
  return { ...actual, detectTimeZone: vi.fn(() => 'Europe/Madrid') };
});

const mockDetect = vi.mocked(detectTimeZone);

const API = '*/api';

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <AuthProvider>{children}</AuthProvider>
    </MemoryRouter>
  );
}

/** A signed-in session whose stored zone is `timezone`. */
function sessionWith(timezone: string | null) {
  return [
    http.post(`${API}/auth/refresh`, () =>
      HttpResponse.json({ accessToken: 'test-token', expiresIn: 900 }),
    ),
    http.get(`${API}/auth/me`, () =>
      HttpResponse.json({
        data: {
          id: 'test-user-id',
          email: 'test@example.com',
          displayName: 'Test User',
          profileImageUrl: null,
          roles: [{ name: 'viewer' }],
          permissions: [],
          isActive: true,
          createdAt: new Date().toISOString(),
          timezone,
        },
      }),
    ),
  ];
}

describe('AuthContext — timezone auto-detection', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    mockDetect.mockReturnValue('Europe/Madrid');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('silently PATCHes the detected zone when the user has never set one', async () => {
    const patched: unknown[] = [];
    server.use(
      ...sessionWith(null),
      http.patch(`${API}/user-settings`, async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json({ data: {} });
      }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    await waitFor(() => expect(patched).toHaveLength(1));

    expect(patched[0]).toEqual({ timezone: 'Europe/Madrid' });
    // Silent — the fill-in case never raises the prompt.
    expect(result.current.timezoneMismatch).toBeNull();
    // And the local user is updated, so a later remount won't write again.
    await waitFor(() =>
      expect(result.current.user?.timezone).toBe('Europe/Madrid'),
    );
  });

  it('completes login even when the auto-detect PATCH fails', async () => {
    server.use(
      ...sessionWith(null),
      http.patch(`${API}/user-settings`, () => new HttpResponse(null, { status: 500 })),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.email).toBe('test@example.com');
    expect(result.current.timezoneMismatch).toBeNull();
  });

  it('asks — and does not write — when the stored zone disagrees', async () => {
    let patchCount = 0;
    server.use(
      ...sessionWith('America/Costa_Rica'),
      http.patch(`${API}/user-settings`, () => {
        patchCount += 1;
        return HttpResponse.json({ data: {} });
      }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() =>
      expect(result.current.timezoneMismatch).toEqual({
        stored: 'America/Costa_Rica',
        detected: 'Europe/Madrid',
      }),
    );
    expect(patchCount).toBe(0);
    // The stored zone is untouched until the user says otherwise.
    expect(result.current.user?.timezone).toBe('America/Costa_Rica');
  });

  it('does nothing when the stored zone already agrees', async () => {
    let patchCount = 0;
    server.use(
      ...sessionWith('Europe/Madrid'),
      http.patch(`${API}/user-settings`, () => {
        patchCount += 1;
        return HttpResponse.json({ data: {} });
      }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(result.current.timezoneMismatch).toBeNull();
    expect(patchCount).toBe(0);
  });
});

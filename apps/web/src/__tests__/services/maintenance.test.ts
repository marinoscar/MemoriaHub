/**
 * Maintenance-mode detection in the central api wrapper (issue #348).
 *
 * The contract under test is narrow and load-bearing: a 503 carrying the API's
 * stable `{ error: 'maintenance', ... }` marker publishes to the global
 * maintenance store so the app can take over with ONE screen, while an
 * ordinary 503 (crashed API, proxy with no upstream) must stay an ordinary
 * ApiError so pages keep rendering their own error states.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { api, ApiError, MaintenanceError } from '../../services/api';
import {
  clearMaintenance,
  getMaintenanceNotice,
} from '../../services/maintenanceState';
import { getMaintenanceState, updateMaintenanceState } from '../../services/maintenance';

const BASE = 'http://localhost:3000/api';

beforeEach(() => {
  api.setAccessToken('test-token');
  clearMaintenance();
});
afterEach(() => {
  api.setAccessToken(null);
  clearMaintenance();
});

/** The shape HttpExceptionFilter produces for a MaintenanceGuard 503. */
function maintenanceBody(overrides: Record<string, unknown> = {}) {
  return {
    statusCode: 503,
    code: 'SERVICE_UNAVAILABLE',
    error: 'maintenance',
    message: 'Upgrading to v2.4, back by 03:00 UTC',
    startedAt: '2026-08-09T20:00:00.000Z',
    timestamp: '2026-08-09T20:05:00.000Z',
    path: '/api/media',
    ...overrides,
  };
}

describe('maintenance 503 detection', () => {
  it('publishes the notice and throws MaintenanceError on a marked 503', async () => {
    server.use(
      http.get(`${BASE}/media`, () =>
        HttpResponse.json(maintenanceBody(), {
          status: 503,
          headers: { 'Retry-After': '120' },
        }),
      ),
    );

    await expect(api.get('/media')).rejects.toBeInstanceOf(MaintenanceError);

    const notice = getMaintenanceNotice();
    expect(notice).not.toBeNull();
    expect(notice?.message).toBe('Upgrading to v2.4, back by 03:00 UTC');
    expect(notice?.startedAt).toBe('2026-08-09T20:00:00.000Z');
  });

  it('carries a fallback message when the admin left one unset', async () => {
    server.use(
      http.get(`${BASE}/media`, () =>
        HttpResponse.json(maintenanceBody({ message: '' }), { status: 503 }),
      ),
    );

    await expect(api.get('/media')).rejects.toThrow();
    expect(getMaintenanceNotice()?.message).toMatch(/down for maintenance/i);
  });

  it('leaves an ORDINARY 503 alone — no notice, plain ApiError', async () => {
    server.use(
      http.get(`${BASE}/media`, () =>
        HttpResponse.json(
          { statusCode: 503, message: 'Upstream unavailable' },
          { status: 503 },
        ),
      ),
    );

    await expect(api.get('/media')).rejects.toBeInstanceOf(ApiError);
    await expect(api.get('/media')).rejects.not.toBeInstanceOf(MaintenanceError);
    expect(getMaintenanceNotice()).toBeNull();
  });

  it('leaves other error statuses alone', async () => {
    server.use(
      http.get(`${BASE}/media`, () =>
        HttpResponse.json({ message: 'Nope', code: 'FORBIDDEN' }, { status: 403 }),
      ),
    );

    await expect(api.get('/media')).rejects.toMatchObject({ status: 403 });
    expect(getMaintenanceNotice()).toBeNull();
  });

  it('MaintenanceError is an ApiError with status 503, so existing handlers still work', async () => {
    server.use(
      http.get(`${BASE}/media`, () =>
        HttpResponse.json(maintenanceBody(), { status: 503 }),
      ),
    );

    const err = await api.get('/media').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('MAINTENANCE');
    expect(err.startedAt).toBe('2026-08-09T20:00:00.000Z');
  });
});

describe('admin maintenance client', () => {
  it('reads the state from GET /admin/maintenance', async () => {
    server.use(
      http.get(`${BASE}/admin/maintenance`, () =>
        HttpResponse.json({
          data: {
            active: true,
            message: 'Upgrading',
            allowAdmins: true,
            startedAt: '2026-08-09T20:00:00.000Z',
            startedById: 'admin-user-id',
            persistedEnabled: true,
            inMemoryOverride: null,
            envOverride: null,
          },
        }),
      ),
    );

    const state = await getMaintenanceState();
    expect(state.active).toBe(true);
    expect(state.allowAdmins).toBe(true);
    expect(state.message).toBe('Upgrading');
  });

  it('sends the toggle body to PUT /admin/maintenance', async () => {
    let received: unknown;
    server.use(
      http.put(`${BASE}/admin/maintenance`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json({
          data: {
            active: true,
            message: 'Back soon',
            allowAdmins: false,
            startedAt: '2026-08-09T20:00:00.000Z',
            startedById: 'admin-user-id',
            persistedEnabled: true,
            inMemoryOverride: null,
            envOverride: null,
          },
        });
      }),
    );

    const state = await updateMaintenanceState({
      enabled: true,
      message: 'Back soon',
      allowAdmins: false,
    });

    expect(received).toEqual({
      enabled: true,
      message: 'Back soon',
      allowAdmins: false,
    });
    expect(state.allowAdmins).toBe(false);
  });
});

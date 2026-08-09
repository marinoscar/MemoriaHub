/**
 * MaintenanceGate + MaintenancePage (issue #348).
 *
 * The behavior worth protecting is the one the issue calls out: a 503 carrying
 * the maintenance marker must produce ONE global maintenance screen with the
 * admin's message, not the ordinary per-page error state — and an ordinary 503
 * must NOT take the app over.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render, mockAdminUser } from '../../utils/test-utils';
import { MaintenanceGate } from '../../../components/common/MaintenanceGate';
import { api } from '../../../services/api';
import { clearMaintenance } from '../../../services/maintenanceState';

const BASE = 'http://localhost:3000/api';

function AppContent() {
  return <div>Normal app content</div>;
}

beforeEach(() => {
  api.setAccessToken('test-token');
  clearMaintenance();
  // The location mock is defined once in setup.ts and shared across tests.
  (window.location.reload as unknown as ReturnType<typeof vi.fn>).mockClear();
});
afterEach(() => {
  api.setAccessToken(null);
  clearMaintenance();
  vi.restoreAllMocks();
});

/** Drive a real request through the api wrapper so the store is populated the
 *  same way it would be in the running app, rather than poking it directly. */
async function triggerMaintenance503(
  body: Record<string, unknown> = {
    error: 'maintenance',
    message: 'Upgrading to v2.4, back by 03:00 UTC',
    startedAt: '2026-08-09T20:00:00.000Z',
  },
) {
  server.use(
    http.get(`${BASE}/media`, () => HttpResponse.json(body, { status: 503 })),
  );
  await api.get('/media').catch(() => undefined);
}

describe('MaintenanceGate', () => {
  it('renders children normally when nothing has reported maintenance', () => {
    render(
      <MaintenanceGate>
        <AppContent />
      </MaintenanceGate>,
    );

    expect(screen.getByText('Normal app content')).toBeInTheDocument();
    expect(screen.queryByText(/down for maintenance/i)).not.toBeInTheDocument();
  });

  it('replaces the app with the maintenance screen after a marked 503', async () => {
    await triggerMaintenance503();

    render(
      <MaintenanceGate>
        <AppContent />
      </MaintenanceGate>,
    );

    expect(await screen.findByText(/down for maintenance/i)).toBeInTheDocument();
    // The admin's custom message, not a generic error.
    expect(
      screen.getByText('Upgrading to v2.4, back by 03:00 UTC'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Maintenance started/i)).toBeInTheDocument();
    expect(screen.queryByText('Normal app content')).not.toBeInTheDocument();
  });

  it('does NOT take over for an ordinary 503 with no maintenance marker', async () => {
    server.use(
      http.get(`${BASE}/media`, () =>
        HttpResponse.json({ message: 'Bad gateway' }, { status: 503 }),
      ),
    );
    await api.get('/media').catch(() => undefined);

    render(
      <MaintenanceGate>
        <AppContent />
      </MaintenanceGate>,
    );

    expect(screen.getByText('Normal app content')).toBeInTheDocument();
    expect(screen.queryByText(/down for maintenance/i)).not.toBeInTheDocument();
  });

  it('offers admins the escape hatch back into the app, and non-admins none', async () => {
    await triggerMaintenance503();

    const { unmount } = render(
      <MaintenanceGate>
        <AppContent />
      </MaintenanceGate>,
      { wrapperOptions: { user: mockAdminUser } },
    );

    const manage = await screen.findByRole('button', {
      name: /manage maintenance mode/i,
    });
    expect(manage).toBeInTheDocument();
    unmount();

    // A non-admin gets the screen but no way past it.
    render(
      <MaintenanceGate>
        <AppContent />
      </MaintenanceGate>,
    );
    expect(await screen.findByText(/down for maintenance/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /manage maintenance mode/i }),
    ).not.toBeInTheDocument();
  });

  it('auto-recovers by reloading once readiness reports healthy again', async () => {
    await triggerMaintenance503();
    server.use(http.get(`${BASE}/health/ready`, () => HttpResponse.json({ status: 'ok' })));

    render(
      <MaintenanceGate>
        <AppContent />
      </MaintenanceGate>,
    );

    const tryAgain = await screen.findByRole('button', { name: /try again/i });
    tryAgain.click();

    await waitFor(() => {
      expect(window.location.reload).toHaveBeenCalled();
    });
  });

  it('stays on the maintenance screen while readiness is still 503', async () => {
    await triggerMaintenance503();
    server.use(
      http.get(`${BASE}/health/ready`, () =>
        HttpResponse.json({ status: 'error' }, { status: 503 }),
      ),
    );

    render(
      <MaintenanceGate>
        <AppContent />
      </MaintenanceGate>,
    );

    const tryAgain = await screen.findByRole('button', { name: /try again/i });
    tryAgain.click();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled();
    });
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(screen.getByText(/down for maintenance/i)).toBeInTheDocument();
  });
});

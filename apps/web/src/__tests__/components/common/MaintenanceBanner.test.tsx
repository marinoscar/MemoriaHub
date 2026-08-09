/**
 * MaintenanceBanner (issue #348).
 *
 * The issue is explicit that leaving maintenance mode on by accident is this
 * feature's most likely real-world failure, so the banner is load-bearing.
 * With allowAdmins:true an admin sees no 503s at all — the app looks entirely
 * normal to the only person who can turn it off — so these tests pin that the
 * banner reads the PERSISTED state and shows up for exactly the users who can
 * act on it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import { MaintenanceBanner } from '../../../components/common/MaintenanceBanner';
import { api } from '../../../services/api';

const BASE = 'http://localhost:3000/api';

function mockState(overrides: Record<string, unknown> = {}) {
  server.use(
    http.get(`${BASE}/admin/maintenance`, () =>
      HttpResponse.json({
        data: {
          active: true,
          message: 'Upgrading to v2.4',
          allowAdmins: true,
          startedAt: '2026-08-09T20:00:00.000Z',
          startedById: 'admin-user-id',
          persistedEnabled: true,
          inMemoryOverride: null,
          envOverride: null,
          ...overrides,
        },
      }),
    ),
  );
}

beforeEach(() => api.setAccessToken('test-token'));
afterEach(() => api.setAccessToken(null));

describe('MaintenanceBanner', () => {
  it('warns an admin while maintenance is active, with the message and a way to manage it', async () => {
    mockState();

    render(<MaintenanceBanner />, {
      wrapperOptions: { user: mockAdminUser },
    });

    expect(await screen.findByText(/maintenance mode is on/i)).toBeInTheDocument();
    expect(screen.getByText(/Upgrading to v2\.4/)).toBeInTheDocument();
    expect(screen.getByText(/Other users cannot use the application/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /manage/i })).toHaveAttribute(
      'href',
      '/admin/settings/general',
    );
  });

  it('spells out that admins are blocked too when allowAdmins is false', async () => {
    mockState({ allowAdmins: false });

    render(<MaintenanceBanner />, {
      wrapperOptions: { user: mockAdminUser },
    });

    expect(
      await screen.findByText(/All users are blocked, including admins/i),
    ).toBeInTheDocument();
  });

  it('renders nothing while maintenance is off', async () => {
    mockState({ active: false, message: '', startedAt: null });

    const { container } = render(<MaintenanceBanner />, {
      wrapperOptions: { user: mockAdminUser },
    });

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing for a user without system_settings:read', async () => {
    mockState();

    const { container } = render(<MaintenanceBanner />, {
      wrapperOptions: { user: mockUser },
    });

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

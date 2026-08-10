/**
 * MaintenanceSettings — the admin toggle on /admin/settings/general (issue #348).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render, mockAdminUser } from '../../utils/test-utils';
import { MaintenanceSettings } from '../../../components/admin/MaintenanceSettings';
import { api } from '../../../services/api';

const BASE = 'http://localhost:3000/api';

function stateBody(overrides: Record<string, unknown> = {}) {
  return {
    active: false,
    message: '',
    allowAdmins: true,
    startedAt: null,
    startedById: null,
    persistedEnabled: false,
    inMemoryOverride: null,
    envOverride: null,
    ...overrides,
  };
}

function mockGet(overrides: Record<string, unknown> = {}) {
  server.use(
    http.get(`${BASE}/admin/maintenance`, () =>
      HttpResponse.json({ data: stateBody(overrides) }),
    ),
  );
}

beforeEach(() => api.setAccessToken('test-token'));
afterEach(() => api.setAccessToken(null));

const adminOptions = { wrapperOptions: { user: mockAdminUser } };

describe('MaintenanceSettings', () => {
  it('renders the toggle, message field, and allowAdmins checkbox seeded from the API', async () => {
    mockGet({ active: true, message: 'Upgrading', allowAdmins: false });

    render(<MaintenanceSettings />, adminOptions);

    const toggle = await screen.findByRole('switch', {
      name: /enable maintenance mode/i,
    });
    await waitFor(() => expect(toggle).toBeChecked());

    expect(screen.getByLabelText(/message shown to users/i)).toHaveValue('Upgrading');
    expect(
      screen.getByRole('checkbox', { name: /allow admins to keep using the app/i }),
    ).not.toBeChecked();
  });

  it('warns about the lockout footgun only once allowAdmins is unchecked', async () => {
    const user = userEvent.setup();
    mockGet();

    render(<MaintenanceSettings />, adminOptions);

    const allowAdmins = await screen.findByRole('checkbox', {
      name: /allow admins to keep using the app/i,
    });
    expect(screen.queryByText(/can lock you out of the admin UI/i)).not.toBeInTheDocument();

    await user.click(allowAdmins);

    expect(await screen.findByText(/can lock you out of the admin UI/i)).toBeInTheDocument();
    expect(screen.getByText(/MAINTENANCE_MODE=false/)).toBeInTheDocument();
  });

  it('submits the toggle, message and allowAdmins to PUT /admin/maintenance', async () => {
    const user = userEvent.setup();
    mockGet();

    let received: unknown;
    server.use(
      http.put(`${BASE}/admin/maintenance`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json({
          data: stateBody({
            active: true,
            message: 'Back at 03:00',
            persistedEnabled: true,
            startedAt: '2026-08-09T20:00:00.000Z',
          }),
        });
      }),
    );

    render(<MaintenanceSettings />, adminOptions);

    const toggle = await screen.findByRole('switch', {
      name: /enable maintenance mode/i,
    });
    await user.click(toggle);
    await user.type(screen.getByLabelText(/message shown to users/i), 'Back at 03:00');

    const save = screen.getByRole('button', { name: /enable maintenance mode/i });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);

    await waitFor(() => {
      expect(received).toEqual({
        enabled: true,
        message: 'Back at 03:00',
        allowAdmins: true,
      });
    });

    // The panel reflects the state the server returned.
    expect(
      await screen.findByText(/maintenance mode is currently on/i),
    ).toBeInTheDocument();
  });

  it('disables every control for a read-only admin', async () => {
    mockGet();

    render(<MaintenanceSettings disabled />, adminOptions);

    const toggle = await screen.findByRole('switch', {
      name: /enable maintenance mode/i,
    });
    expect(toggle).toBeDisabled();
    expect(screen.getByLabelText(/message shown to users/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('says a MAINTENANCE_MODE env override wins over whatever is saved', async () => {
    mockGet({ envOverride: false });

    render(<MaintenanceSettings />, adminOptions);

    expect(
      await screen.findByText(/environment variable is set to/i),
    ).toBeInTheDocument();
  });
});

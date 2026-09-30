/**
 * `/admin/settings/broadcasts` — epic #481, issue #488.
 *
 * The services are mocked and the DataTable is replaced by a minimal list that
 * exposes the row-action contract verbatim (the DbBackupPage precedent): the
 * real grid is heavy in jsdom and nothing here is about grid internals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';
import { makeBroadcast } from '../fixtures/broadcasts';

vi.mock('../../hooks/usePermissions', () => ({ usePermissions: vi.fn() }));

vi.mock('../../services/broadcasts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/broadcasts')>();
  return {
    ...actual,
    getBroadcasts: vi.fn(),
    getBroadcast: vi.fn(),
    getBroadcastAudience: vi.fn(),
    createBroadcast: vi.fn(),
    cancelBroadcast: vi.fn(),
    resumeBroadcast: vi.fn(),
    deleteBroadcast: vi.fn(),
    sendTestBroadcast: vi.fn(),
  };
});

vi.mock('../../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/notifications')>();
  return {
    ...actual,
    getNotificationConfig: vi.fn().mockResolvedValue({
      pushEnabled: true,
      vapidPublicKey: 'k',
      browserEnabled: true,
      pushTypes: [],
    }),
  };
});

vi.mock('../../components/datatable', () => ({
  DataTable: ({ rows, rowActions, rowId, emptyState }: any) => (
    <div data-testid="datatable">
      {rows.length === 0 && emptyState}
      {rows.map((row: any) => (
        <div key={rowId(row)} data-testid={`row-${rowId(row)}`}>
          <span>{row.title}</span>
          {(rowActions ?? []).map((action: any) => (
            <button
              key={action.id}
              type="button"
              disabled={action.disabled ? action.disabled(row) : false}
              onClick={() => action.onClick(row)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  ),
}));

import { usePermissions } from '../../hooks/usePermissions';
import {
  cancelBroadcast,
  createBroadcast,
  getBroadcast,
  getBroadcastAudience,
  getBroadcasts,
  resumeBroadcast,
} from '../../services/broadcasts';
import BroadcastsPage from '../../pages/Admin/BroadcastsPage';

function setPermissions(granted: string[]) {
  vi.mocked(usePermissions).mockReturnValue({
    permissions: new Set(granted),
    roles: new Set(['admin']),
    hasPermission: (permission: string) => granted.includes(permission),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin: true,
  });
}

function setRows(rows: ReturnType<typeof makeBroadcast>[]) {
  vi.mocked(getBroadcasts).mockResolvedValue({
    items: rows,
    meta: { page: 1, pageSize: 20, totalItems: rows.length, totalPages: 1 },
  });
}

const renderPage = () => render(<BroadcastsPage />, { wrapperOptions: { user: mockAdminUser } });

describe('BroadcastsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(['broadcasts:read', 'broadcasts:write']);
    setRows([makeBroadcast()]);
    vi.mocked(getBroadcastAudience).mockResolvedValue({ activeUsers: 42 });
  });

  it('renders the header and loads the first page', async () => {
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Broadcasts' })).toBeInTheDocument();
    expect(await screen.findByText('Planned maintenance')).toBeInTheDocument();
    expect(getBroadcasts).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
    expect(screen.getByText(/not being refreshed automatically/i)).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    setRows([]);
    renderPage();
    expect(await screen.findByText('Nothing has been announced yet')).toBeInTheDocument();
  });

  it('says it is polling while something is in flight', async () => {
    setRows([makeBroadcast({ status: 'sending', recipientCount: 100, processedCount: 20 })]);
    renderPage();
    expect(await screen.findByText(/refreshes every 10 seconds/i)).toBeInTheDocument();
  });

  it('is read-only without broadcasts:write: New and every write action disabled', async () => {
    setPermissions(['broadcasts:read']);
    setRows([makeBroadcast({ status: 'failed' })]);
    renderPage();

    const row = await screen.findByTestId(`row-${makeBroadcast().id}`);
    expect(screen.getByRole('button', { name: /new broadcast/i })).toBeDisabled();
    expect(screen.getByText(/\(read-only\)/)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'View broadcast' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: 'Resume broadcast' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Cancel broadcast' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Delete broadcast' })).toBeDisabled();
  });

  it('gates row actions by status', async () => {
    setRows([makeBroadcast({ status: 'sending' })]);
    renderPage();
    const row = await screen.findByTestId(`row-${makeBroadcast().id}`);
    expect(within(row).getByRole('button', { name: 'Cancel broadcast' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: 'Delete broadcast' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Resume broadcast' })).toBeDisabled();
  });

  it('resumes a failed broadcast and refreshes the list', async () => {
    const user = userEvent.setup();
    const failed = makeBroadcast({ status: 'failed' });
    setRows([failed]);
    vi.mocked(resumeBroadcast).mockResolvedValue({ ...failed, status: 'sending' });
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Resume broadcast' }));

    await waitFor(() => expect(resumeBroadcast).toHaveBeenCalledWith(failed.id));
    expect(await screen.findByText('Broadcast resumed.')).toBeInTheDocument();
    await waitFor(() => expect(getBroadcasts).toHaveBeenCalledTimes(2));
  });

  it('shows the API refusal when a cancel loses the race', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../services/api');
    setRows([makeBroadcast({ status: 'scheduled' })]);
    vi.mocked(cancelBroadcast).mockRejectedValue(new ApiError("Broadcast is 'sent'", 409));
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Cancel broadcast' }));

    expect(await screen.findByText("Broadcast is 'sent'")).toBeInTheDocument();
  });

  it('opens the detail dialog with the freshly read broadcast', async () => {
    const user = userEvent.setup();
    vi.mocked(getBroadcast).mockResolvedValue(makeBroadcast({ body: 'Fresh body' }));
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'View broadcast' }));

    const dialog = await screen.findByRole('dialog', { name: 'Broadcast' });
    expect(await within(dialog).findByText('Fresh body')).toBeInTheDocument();
  });

  it('composes and queues a broadcast, re-reading the audience on open', async () => {
    const user = userEvent.setup();
    vi.mocked(createBroadcast).mockResolvedValue(makeBroadcast({ status: 'scheduled' }));
    renderPage();
    await screen.findByText('Planned maintenance');

    await user.click(screen.getByRole('button', { name: /new broadcast/i }));
    const composer = await screen.findByRole('dialog', { name: 'New broadcast' });
    expect(await within(composer).findByText(/goes to all 42 active users/i)).toBeInTheDocument();
    await user.type(within(composer).getByLabelText(/^title/i), 'Hello');
    await user.type(within(composer).getByLabelText(/^body/i), 'World');
    await user.click(within(composer).getByRole('button', { name: 'Send…' }));
    await user.click(await screen.findByRole('button', { name: 'Send broadcast' }));

    await waitFor(() =>
      expect(createBroadcast).toHaveBeenCalledWith({
        title: 'Hello',
        body: 'World',
        critical: false,
        channels: ['inbox'],
      }),
    );
    expect(await screen.findByText(/broadcast queued/i)).toBeInTheDocument();
  });

  it('redirects away without broadcasts:read', () => {
    setPermissions([]);
    renderPage();
    expect(screen.queryByRole('heading', { level: 1, name: 'Broadcasts' })).not.toBeInTheDocument();
  });

  it('shows a list load error', async () => {
    vi.mocked(getBroadcasts).mockRejectedValue(new Error('down'));
    renderPage();
    expect(await screen.findByText('Failed to load broadcasts')).toBeInTheDocument();
  });
});

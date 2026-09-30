/**
 * `/admin/settings/notifications` — epic #481, issue #487.
 *
 * `useSystemSettings` and `usePermissions` are mocked; the suite covers the
 * page's own contract: the three policy keys it reads and PATCHes (and ONLY
 * those — the retention keys another page edits must never be sent), the
 * inverted per-type switches, the keep-every-suppression-listed rule, and the
 * `system_settings:write` gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';

vi.mock('../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { useSystemSettings } from '../../hooks/useSystemSettings';
import { usePermissions } from '../../hooks/usePermissions';
import NotificationPolicyPage from '../../pages/Admin/NotificationPolicyPage';
import { NOTIFICATION_TYPE_CATALOG } from '../../components/admin/notificationTypeCatalog';

const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockUsePermissions = vi.mocked(usePermissions);

function setPermissions(granted: string[]) {
  mockUsePermissions.mockReturnValue({
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

function setSettings(notifications: Record<string, unknown> | undefined, overrides = {}) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  mockUseSystemSettings.mockReturnValue({
    settings: {
      version: 4,
      notifications,
    } as any,
    isLoading: false,
    error: null,
    isSaving: false,
    updateSettings,
    replaceSettings: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  });
  return updateSettings;
}

const renderPage = () =>
  render(<NotificationPolicyPage />, { wrapperOptions: { user: mockAdminUser } });

describe('NotificationPolicyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(['system_settings:read', 'system_settings:write']);
  });

  it('renders the header, both channel switches, and every catalogued type', () => {
    setSettings({ retentionDays: 30, purgeEnabled: true, browserEnabled: true, pushEnabled: true, disabledTypes: [] });

    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByLabelText(/show browser notifications while the app is open/i)).toBeChecked();
    expect(screen.getByLabelText(/send web push notifications/i)).toBeChecked();
    for (const info of NOTIFICATION_TYPE_CATALOG) {
      expect(screen.getByLabelText(`Deliver ${info.label} notifications`)).toBeChecked();
    }
  });

  it('explains that turning a type off stops inbox rows AND push', () => {
    setSettings({});

    renderPage();

    expect(screen.getByText(/stops new inbox notifications/i)).toBeInTheDocument();
    expect(screen.getByText(/Inbox always delivered/, { selector: 'p' })).toBeInTheDocument();
  });

  it('labels a mandatory type with the inbox-always chip', () => {
    setSettings({});

    renderPage();

    expect(screen.getByText('Inbox always delivered', { selector: 'span' })).toBeInTheDocument();
  });

  it('defaults to everything on when an older API returns no policy keys', () => {
    setSettings(undefined);

    renderPage();

    expect(screen.getByLabelText(/send web push notifications/i)).toBeChecked();
    expect(screen.getByLabelText('Deliver Upload complete notifications')).toBeChecked();
  });

  it('renders a stored suppression as a switched-off type', () => {
    setSettings({ disabledTypes: ['upload_completed'] });

    renderPage();

    expect(screen.getByLabelText('Deliver Upload complete notifications')).not.toBeChecked();
    expect(screen.getByText('Off for everyone')).toBeInTheDocument();
  });

  it('keeps an unrecognised stored suppression listed so it can be lifted', () => {
    setSettings({ disabledTypes: ['some_future_type'] });

    renderPage();

    const toggle = screen.getByLabelText('Deliver some_future_type notifications');
    expect(toggle).not.toBeChecked();
  });

  it('PATCHes only the three policy keys, never the retention settings', async () => {
    const user = userEvent.setup();
    const updateSettings = setSettings({
      retentionDays: 45,
      purgeEnabled: false,
      browserEnabled: true,
      pushEnabled: true,
      disabledTypes: [],
    });

    renderPage();
    await user.click(screen.getByLabelText(/send web push notifications/i));
    await user.click(screen.getByLabelText('Deliver Share expiring notifications'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({
      notifications: {
        browserEnabled: true,
        pushEnabled: false,
        disabledTypes: ['share_expiring'],
      },
    });
    expect(await screen.findByText('Notification settings saved')).toBeInTheDocument();
  });

  it('re-enabling a suppressed type removes it from the list', async () => {
    const user = userEvent.setup();
    const updateSettings = setSettings({ disabledTypes: ['upload_completed', 'memories_ready'] });

    renderPage();
    await user.click(screen.getByLabelText('Deliver Upload complete notifications'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        notifications: expect.objectContaining({ disabledTypes: ['memories_ready'] }),
      }),
    );
  });

  it('Save and Discard are disabled until something changes, and Discard reverts', async () => {
    const user = userEvent.setup();
    setSettings({ browserEnabled: true });

    renderPage();
    const save = screen.getByRole('button', { name: /save changes/i });
    const discard = screen.getByRole('button', { name: /discard changes/i });
    expect(save).toBeDisabled();
    expect(discard).toBeDisabled();

    const browser = screen.getByLabelText(/show browser notifications while the app is open/i);
    await user.click(browser);
    expect(save).toBeEnabled();
    await user.click(discard);
    expect(browser).toBeChecked();
    expect(save).toBeDisabled();
  });

  it('notes that the type switches control inbox only while push is off', () => {
    setSettings({ pushEnabled: false });

    renderPage();

    expect(screen.getByText(/control inbox delivery only/i)).toBeInTheDocument();
  });

  it('shows a save failure', async () => {
    const user = userEvent.setup();
    const updateSettings = setSettings({});
    updateSettings.mockRejectedValue(new Error('Settings were updated elsewhere.'));

    renderPage();
    await user.click(screen.getByLabelText(/send web push notifications/i));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('Settings were updated elsewhere.')).toBeInTheDocument();
  });

  it('disables every control without system_settings:write', () => {
    setPermissions(['system_settings:read']);
    setSettings({});

    renderPage();

    expect(screen.getByLabelText(/send web push notifications/i)).toBeDisabled();
    const types = screen.getByLabelText('Notification type switches');
    within(types)
      .getAllByRole('switch')
      .forEach((toggle) => expect(toggle).toBeDisabled());
    expect(screen.getByText(/requires system_settings:write/i)).toBeInTheDocument();
  });

  it('redirects away without system_settings:read', () => {
    setPermissions([]);
    setSettings({});

    renderPage();

    expect(screen.queryByRole('heading', { level: 1, name: 'Notifications' })).not.toBeInTheDocument();
  });

  it('shows a load error', () => {
    setSettings(undefined, { settings: null, error: 'Failed to load settings' });

    renderPage();

    expect(screen.getByText('Failed to load settings')).toBeInTheDocument();
  });

  it('links to the Web Push page', () => {
    setSettings({});

    renderPage();

    expect(screen.getByRole('link', { name: 'Web Push' })).toHaveAttribute(
      'href',
      '/admin/settings/push',
    );
  });
});

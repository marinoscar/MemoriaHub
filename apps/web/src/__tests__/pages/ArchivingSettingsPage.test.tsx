/**
 * Unit tests for ArchivingSettingsPage.
 *
 * Mocking strategy:
 *   - usePermissions is module-mocked to control admin/permission state.
 *   - useSystemSettings is module-mocked to control the seeded trash retention value.
 *
 * The page redirects/blocks when the user lacks system_settings:read. Admins see:
 *   - "Back to Settings" breadcrumb link.
 *   - A "Trash retention period (days)" field seeded from settings.storage.trash.retentionDays.
 *   - "View Archive" / "View Trash" links to /archive and /trash.
 *   - Saving calls updateSettings with { storage: { trash: { retentionDays } } }.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import ArchivingSettingsPage from '../../pages/Admin/ArchivingSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseSystemSettings = vi.mocked(useSystemSettings);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminPermissions() {
  return {
    isAdmin: true,
    permissions: new Set(['system_settings:read', 'system_settings:write']),
    roles: new Set(['admin']),
    hasPermission: vi.fn().mockReturnValue(true),
    hasAnyPermission: vi.fn().mockReturnValue(true),
    hasAllPermissions: vi.fn().mockReturnValue(true),
    hasRole: vi.fn().mockReturnValue(true),
    hasAnyRole: vi.fn().mockReturnValue(true),
  };
}

function readOnlyPermissions() {
  return {
    isAdmin: true,
    permissions: new Set(['system_settings:read']),
    roles: new Set(['admin']),
    hasPermission: (perm: string) => perm === 'system_settings:read',
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
  };
}

function noPermissions() {
  return {
    isAdmin: false,
    permissions: new Set<string>(),
    roles: new Set<string>(),
    hasPermission: vi.fn().mockReturnValue(false),
    hasAnyPermission: vi.fn().mockReturnValue(false),
    hasAllPermissions: vi.fn().mockReturnValue(false),
    hasRole: vi.fn().mockReturnValue(false),
    hasAnyRole: vi.fn().mockReturnValue(false),
  };
}

function makeSystemSettingsMock(retentionDays = 30) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  return {
    settings: {
      ui: { allowUserThemeOverride: true },
      features: { autoTagging: false, faceRecognition: false, burstDetection: false },
      storage: { trash: { retentionDays } },
      updatedAt: new Date().toISOString(),
      updatedBy: null,
      version: 1,
    },
    isLoading: false,
    isSaving: false,
    error: null,
    updateSettings,
    replaceSettings: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArchivingSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(adminPermissions() as any);
    mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(30) as any);
  });

  // -------------------------------------------------------------------------
  describe('access control', () => {
    it('redirects/blocks users lacking system_settings:read', () => {
      mockUsePermissions.mockReturnValue(noPermissions() as any);

      render(<ArchivingSettingsPage />);

      expect(
        screen.queryByRole('heading', { name: /archiving/i }),
      ).not.toBeInTheDocument();
    });

    it('renders the page for users with system_settings:read', () => {
      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        screen.getByRole('heading', { name: /archiving.*deletion/i }),
      ).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('page structure', () => {
    it('renders the "Back to Settings" breadcrumb link to /admin/settings', () => {
      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const link = screen.getByText(/back to settings/i).closest('a');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', '/admin/settings');
    });

    it('renders "View Archive" and "View Trash" links', () => {
      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const archiveLink = screen.getByRole('link', { name: /view archive/i });
      const trashLink = screen.getByRole('link', { name: /view trash/i });
      expect(archiveLink).toHaveAttribute('href', '/archive');
      expect(trashLink).toHaveAttribute('href', '/trash');
    });
  });

  // -------------------------------------------------------------------------
  describe('trash retention field', () => {
    it('seeds the retention field from settings.storage.trash.retentionDays', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(45) as any);

      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const input = screen.getByRole('spinbutton', {
        name: /trash retention period/i,
      }) as HTMLInputElement;
      expect(input.value).toBe('45');
    });

    it('defaults to 30 when no retentionDays is configured', () => {
      mockUseSystemSettings.mockReturnValue({
        ...makeSystemSettingsMock(),
        settings: {
          ui: { allowUserThemeOverride: true },
          features: {},
          storage: {},
          updatedAt: new Date().toISOString(),
          updatedBy: null,
          version: 1,
        },
      } as any);

      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const input = screen.getByRole('spinbutton', {
        name: /trash retention period/i,
      }) as HTMLInputElement;
      expect(input.value).toBe('30');
    });

    it('shows a validation error for out-of-range values', () => {
      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const input = screen.getByRole('spinbutton', { name: /trash retention period/i });
      fireEvent.change(input, { target: { value: '0' } });

      expect(screen.getByText(/must be between 1 and 365/i)).toBeInTheDocument();
    });

    it('disables Save Changes when the field is invalid', () => {
      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const input = screen.getByRole('spinbutton', { name: /trash retention period/i });
      fireEvent.change(input, { target: { value: '366' } });

      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });

    it('disables Save Changes when no changes have been made', () => {
      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  describe('saving', () => {
    it('calls updateSettings with { storage: { trash: { retentionDays } } } on save', async () => {
      const mock = makeSystemSettingsMock(30);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const input = screen.getByRole('spinbutton', { name: /trash retention period/i });
      await user.clear(input);
      await user.type(input, '14');

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith({
          storage: { trash: { retentionDays: 14 } },
        });
      });
    });

    it('shows a success message after saving', async () => {
      const mock = makeSystemSettingsMock(30);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const input = screen.getByRole('spinbutton', { name: /trash retention period/i });
      await user.clear(input);
      await user.type(input, '14');

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(screen.getByText(/trash retention period saved/i)).toBeInTheDocument();
      });
    });

    it('shows an error message when saving fails', async () => {
      const mock = makeSystemSettingsMock(30);
      mock.updateSettings.mockRejectedValue(new Error('Save failed'));
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const input = screen.getByRole('spinbutton', { name: /trash retention period/i });
      await user.clear(input);
      await user.type(input, '14');

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(screen.getByText(/save failed/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('read-only mode', () => {
    it('disables the retention field and Save button for users lacking system_settings:write', () => {
      mockUsePermissions.mockReturnValue(readOnlyPermissions() as any);

      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const input = screen.getByRole('spinbutton', { name: /trash retention period/i });
      expect(input).toBeDisabled();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  describe('loading and error states', () => {
    it('shows a loading spinner while settings are loading', () => {
      mockUseSystemSettings.mockReturnValue({
        settings: null,
        isLoading: true,
        isSaving: false,
        error: null,
        updateSettings: vi.fn(),
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      } as any);

      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows an error alert when settings fail to load', () => {
      mockUseSystemSettings.mockReturnValue({
        settings: null,
        isLoading: false,
        isSaving: false,
        error: 'Failed to load settings',
        updateSettings: vi.fn(),
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      } as any);

      render(<ArchivingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });
});

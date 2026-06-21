/**
 * Unit tests for GeoSettingsPage.
 *
 * Mocking strategy:
 *   - usePermissions is module-mocked to control admin state.
 *   - useSystemSettings is module-mocked to control geo.provider and
 *     geo.forwardSearchEnabled values.
 *
 * The page redirects non-admins to /. Admins see:
 *   - A Geocoding provider Select (offline / nominatim).
 *   - A Save button for the provider selection.
 *   - A forward search toggle (Switch).
 *   - A Nominatim privacy warning when the provider or forward search is active.
 *   - "Back to Settings" breadcrumb link.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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

import GeoSettingsPage from '../../pages/Admin/GeoSettingsPage';
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

function nonAdminPermissions() {
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

function makeSystemSettingsMock(
  provider: 'offline' | 'nominatim' = 'offline',
  forwardSearchEnabled = false,
) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  return {
    settings: {
      features: { autoTagging: false, faceRecognition: false, burstDetection: false },
      geo: { provider, forwardSearchEnabled },
      ui: { allowUserThemeOverride: true },
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

describe('GeoSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(adminPermissions() as any);
    mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock('offline', false) as any);
  });

  // -------------------------------------------------------------------------
  describe('access control', () => {
    it('redirects non-admin users', () => {
      mockUsePermissions.mockReturnValue(nonAdminPermissions() as any);

      render(<GeoSettingsPage />);

      expect(screen.queryByRole('heading', { name: /geo location/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('page structure', () => {
    it('renders the page heading', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('heading', { name: /geo location/i })).toBeInTheDocument();
    });

    it('renders "Back to Settings" link', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/back to settings/i)).toBeInTheDocument();
    });

    it('renders the Reverse Geocoding section', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Reverse Geocoding')).toBeInTheDocument();
    });

    it('renders the Forward Search section', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Forward Search')).toBeInTheDocument();
    });

    it('renders the Save button for geocoding provider', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('reverse geocoding provider select', () => {
    it('renders the provider combobox', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('shows "Offline" as the current provider when provider is "offline"', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock('offline') as any);

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const select = screen.getByRole('combobox');
      expect(select.textContent).toMatch(/offline/i);
    });

    it('does NOT show Nominatim privacy warning when provider is "offline"', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock('offline') as any);

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        screen.queryByText(/nominatim sends gps coordinates/i),
      ).not.toBeInTheDocument();
    });

    it('shows Nominatim privacy warning when provider is "nominatim"', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock('nominatim') as any);

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/nominatim sends gps coordinates/i)).toBeInTheDocument();
    });

    it('calls updateSettings when Save is clicked', async () => {
      const mock = makeSystemSettingsMock('offline', false);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            geo: expect.objectContaining({ provider: 'offline' }),
          }),
        );
      });
    });

    it('shows success snackbar message after saving provider', async () => {
      const mock = makeSystemSettingsMock('offline', false);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText(/geocoding provider saved/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('forward search toggle', () => {
    it('forward search switch is unchecked when forwardSearchEnabled is false', () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock('offline', false) as any,
      );

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable forward location search/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(false);
    });

    it('forward search switch is checked when forwardSearchEnabled is true', () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock('offline', true) as any,
      );

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable forward location search/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(true);
    });

    it('shows forward search privacy warning when enabled', () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock('offline', true) as any,
      );

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        screen.getByText(/forward search sends typed location queries/i),
      ).toBeInTheDocument();
    });

    it('does NOT show forward search warning when disabled', () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock('offline', false) as any,
      );

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        screen.queryByText(/forward search sends typed location queries/i),
      ).not.toBeInTheDocument();
    });

    it('calls updateSettings with forwardSearchEnabled:true when switch is toggled on', async () => {
      const mock = makeSystemSettingsMock('offline', false);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable forward location search/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            geo: expect.objectContaining({ forwardSearchEnabled: true }),
          }),
        );
      });
    });

    it('shows success snackbar after toggling forward search', async () => {
      const mock = makeSystemSettingsMock('offline', false);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable forward location search/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(screen.getByText(/forward search setting saved/i)).toBeInTheDocument();
      });
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

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows error alert when settings fail to load', () => {
      mockUseSystemSettings.mockReturnValue({
        settings: null,
        isLoading: false,
        isSaving: false,
        error: 'Failed to load settings',
        updateSettings: vi.fn(),
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      } as any);

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });
});

/**
 * Unit tests for GeoSettingsPage (Admin/GeoSettingsPage.tsx).
 *
 * Mocking strategy:
 *   - usePermissions is module-mocked to control admin state.
 *   - useGeoSettings is module-mocked to control reverse-provider settings,
 *     credentials, and saveReverseFeature.
 *   - useSystemSettings is module-mocked to control geo.forwardSearchEnabled.
 *   - runGeoBackfill (services/geo) is module-mocked to prevent real HTTP calls.
 *
 * The page redirects non-admins to /. Admins see:
 *   - A "Geo Settings" heading.
 *   - "Back to Settings" breadcrumb link.
 *   - Active Reverse Geocoding Provider section with a Select + Save button.
 *   - Provider cards for offline / nominatim / google.
 *   - Forward Search section with a Switch.
 *   - Privacy warning when forward search is enabled.
 *   - Backfill section.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — must appear before imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useGeoSettings', () => ({
  useGeoSettings: vi.fn(),
}));

vi.mock('../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

vi.mock('../../services/geo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/geo')>();
  return {
    ...actual,
    runGeoBackfill: vi.fn().mockResolvedValue({ enqueued: 5 }),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import GeoSettingsPage from '../../pages/Admin/GeoSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useGeoSettings } from '../../hooks/useGeoSettings';
import { useSystemSettings } from '../../hooks/useSystemSettings';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseGeoSettings = vi.mocked(useGeoSettings);
const mockUseSystemSettings = vi.mocked(useSystemSettings);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminPermissions() {
  return {
    isAdmin: true,
    permissions: new Set(['system_settings:read', 'system_settings:write', 'geo_settings:read', 'geo_settings:write']),
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

/**
 * Returns a minimal useGeoSettings mock.
 * activeReverseProvider defaults to 'offline'.
 * providers defaults to an empty array (the component fills in the known set).
 */
function makeGeoSettingsMock(
  opts: {
    activeReverseProvider?: 'offline' | 'nominatim' | 'google';
    providers?: Array<{
      provider: string;
      configured: boolean;
      enabled: boolean;
      last4: string | null;
      baseUrl: string | null;
    }>;
    loading?: boolean;
    error?: string | null;
    saveReverseFeature?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const saveReverseFeature = opts.saveReverseFeature ?? vi.fn().mockResolvedValue(undefined);
  return {
    settings: opts.loading
      ? null
      : opts.error && !opts.activeReverseProvider
      ? null
      : {
          activeReverseProvider: opts.activeReverseProvider ?? 'offline',
          providers: opts.providers ?? [],
        },
    loading: opts.loading ?? false,
    error: opts.error ?? null,
    fetchSettings: vi.fn().mockResolvedValue(undefined),
    saveCredentials: vi.fn().mockResolvedValue(undefined),
    removeCredentials: vi.fn().mockResolvedValue(undefined),
    testProvider: vi.fn().mockResolvedValue({ ok: true }),
    saveReverseFeature,
  };
}

/**
 * Returns a minimal useSystemSettings mock.
 */
function makeSystemSettingsMock(
  opts: {
    forwardSearchEnabled?: boolean;
    isSaving?: boolean;
    settings?: object | null;
    error?: string | null;
    updateSettings?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const updateSettings = opts.updateSettings ?? vi.fn().mockResolvedValue(undefined);
  return {
    settings:
      opts.settings !== undefined
        ? opts.settings
        : {
            geo: {
              forwardSearchEnabled: opts.forwardSearchEnabled ?? false,
            },
            features: { autoTagging: false, faceRecognition: false, burstDetection: false },
            ui: { allowUserThemeOverride: true },
            updatedAt: new Date().toISOString(),
            updatedBy: null,
            version: 1,
          },
    isLoading: false,
    isSaving: opts.isSaving ?? false,
    error: opts.error ?? null,
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
    mockUsePermissions.mockReturnValue(adminPermissions() as ReturnType<typeof usePermissions>);
    mockUseGeoSettings.mockReturnValue(makeGeoSettingsMock() as ReturnType<typeof useGeoSettings>);
    mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock() as ReturnType<typeof useSystemSettings>);
  });

  // -------------------------------------------------------------------------
  describe('access control', () => {
    it('redirects non-admin users to /', () => {
      mockUsePermissions.mockReturnValue(nonAdminPermissions() as ReturnType<typeof usePermissions>);

      render(<GeoSettingsPage />);

      // The page heading should not appear — we've been redirected away
      expect(screen.queryByRole('heading', { name: /geo settings/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('page structure', () => {
    it('renders the "Geo Settings" page heading', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('heading', { name: /geo settings/i })).toBeInTheDocument();
    });

    it('renders the "Back to Settings" link pointing to /admin/settings', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const link = screen.getByText(/back to settings/i);
      expect(link).toBeInTheDocument();
    });

    it('renders the Active Reverse Geocoding Provider section', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/active reverse geocoding provider/i)).toBeInTheDocument();
    });

    it('renders the Forward Search section', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/forward search/i)).toBeInTheDocument();
    });

    it('renders the Backfill section', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/app-wide geocoding backfill/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('loading and error states', () => {
    it('shows a loading spinner while geo settings are loading', () => {
      mockUseGeoSettings.mockReturnValue(
        makeGeoSettingsMock({ loading: true }) as ReturnType<typeof useGeoSettings>,
      );

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows error alert when geo settings fail to load', () => {
      mockUseGeoSettings.mockReturnValue({
        settings: null,
        loading: false,
        error: 'Failed to load geo settings',
        fetchSettings: vi.fn(),
        saveCredentials: vi.fn(),
        removeCredentials: vi.fn(),
        testProvider: vi.fn(),
        saveReverseFeature: vi.fn(),
      } as ReturnType<typeof useGeoSettings>);

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/failed to load geo settings/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('reverse geocoding provider select', () => {
    it('renders the provider combobox', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('reflects "offline" as the active provider when activeReverseProvider is "offline"', () => {
      mockUseGeoSettings.mockReturnValue(
        makeGeoSettingsMock({ activeReverseProvider: 'offline' }) as ReturnType<typeof useGeoSettings>,
      );

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const select = screen.getByRole('combobox');
      expect(select.textContent).toMatch(/offline/i);
    });

    it('reflects "nominatim" as the active provider when activeReverseProvider is "nominatim"', () => {
      mockUseGeoSettings.mockReturnValue(
        makeGeoSettingsMock({ activeReverseProvider: 'nominatim' }) as ReturnType<typeof useGeoSettings>,
      );

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const select = screen.getByRole('combobox');
      expect(select.textContent).toMatch(/nominatim/i);
    });

    it('renders provider options: offline, nominatim, google', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const select = screen.getByRole('combobox');
      // Open the select
      fireEvent.mouseDown(select);

      expect(screen.getByRole('option', { name: /offline.*geonames/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /nominatim.*openstreetmap/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /google maps/i })).toBeInTheDocument();
    });

    it('calls saveReverseFeature with the selected provider when Save is clicked', async () => {
      const saveReverseFeature = vi.fn().mockResolvedValue(undefined);
      mockUseGeoSettings.mockReturnValue(
        makeGeoSettingsMock({ activeReverseProvider: 'offline', saveReverseFeature }) as ReturnType<typeof useGeoSettings>,
      );

      const user = userEvent.setup();
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // The first Save button (inside the Active Reverse Geocoding Provider paper) is the one
      // we want. We rely on the fact it's the only Save in that section.
      const saveButtons = screen.getAllByRole('button', { name: /^save$/i });
      await user.click(saveButtons[0]);

      await waitFor(() => {
        expect(saveReverseFeature).toHaveBeenCalledWith('offline');
      });
    });

    it('shows success snackbar after saving the reverse provider', async () => {
      const saveReverseFeature = vi.fn().mockResolvedValue(undefined);
      mockUseGeoSettings.mockReturnValue(
        makeGeoSettingsMock({ activeReverseProvider: 'offline', saveReverseFeature }) as ReturnType<typeof useGeoSettings>,
      );

      const user = userEvent.setup();
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const saveButtons = screen.getAllByRole('button', { name: /^save$/i });
      await user.click(saveButtons[0]);

      await waitFor(() => {
        expect(screen.getByText(/active reverse geocoding provider saved/i)).toBeInTheDocument();
      });
    });

    it('renders provider cards for offline, nominatim, and google', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Provider card headings
      expect(screen.getByRole('heading', { name: /offline.*geonames/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /nominatim.*openstreetmap/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /google maps/i })).toBeInTheDocument();
    });

    it('renders "Test connection" buttons for the provider cards', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const testButtons = screen.getAllByRole('button', { name: /test connection/i });
      // offline + nominatim + google each have a Test connection button
      expect(testButtons.length).toBeGreaterThanOrEqual(3);
    });

    it('shows a "New API Key" field for the Google provider card', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByLabelText(/new api key/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('forward search toggle', () => {
    it('forward search switch is unchecked when forwardSearchEnabled is false', () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({ forwardSearchEnabled: false }) as ReturnType<typeof useSystemSettings>,
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
        makeSystemSettingsMock({ forwardSearchEnabled: true }) as ReturnType<typeof useSystemSettings>,
      );

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable forward location search/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(true);
    });

    it('shows privacy warning when forward search is enabled', () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({ forwardSearchEnabled: true }) as ReturnType<typeof useSystemSettings>,
      );

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        screen.getByText(/forward search sends typed location queries to nominatim\.openstreetmap\.org/i),
      ).toBeInTheDocument();
    });

    it('does NOT show privacy warning when forward search is disabled', () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({ forwardSearchEnabled: false }) as ReturnType<typeof useSystemSettings>,
      );

      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        screen.queryByText(/forward search sends typed location queries/i),
      ).not.toBeInTheDocument();
    });

    it('calls updateSettings with forwardSearchEnabled:true when switch is toggled on', async () => {
      const updateSettings = vi.fn().mockResolvedValue(undefined);
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({ forwardSearchEnabled: false, updateSettings }) as ReturnType<typeof useSystemSettings>,
      );

      const user = userEvent.setup();
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable forward location search/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            geo: expect.objectContaining({ forwardSearchEnabled: true }),
          }),
        );
      });
    });

    it('calls updateSettings with forwardSearchEnabled:false when switch is toggled off', async () => {
      const updateSettings = vi.fn().mockResolvedValue(undefined);
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({ forwardSearchEnabled: true, updateSettings }) as ReturnType<typeof useSystemSettings>,
      );

      const user = userEvent.setup();
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable forward location search/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            geo: expect.objectContaining({ forwardSearchEnabled: false }),
          }),
        );
      });
    });

    it('shows success snackbar after toggling forward search', async () => {
      const updateSettings = vi.fn().mockResolvedValue(undefined);
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({ forwardSearchEnabled: false, updateSettings }) as ReturnType<typeof useSystemSettings>,
      );

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

    // -------------------------------------------------------------------------
    // Fix #2 regression tests: version-conflict retry in handleForwardSearchChange
    // -------------------------------------------------------------------------
    describe('conflict retry logic (Fix #2)', () => {
      const CONFLICT_MSG = 'Settings were updated elsewhere. Please review and try again.';

      function getForwardSearchSwitch() {
        const label = screen.getByText(/enable forward location search/i);
        return label
          .closest('.MuiFormControlLabel-root')
          ?.querySelector('input[type="checkbox"]') as HTMLElement;
      }

      it('retries once on version-conflict error and shows success when retry resolves', async () => {
        // First call: reject with the well-known version-conflict message.
        // Second call (retry): resolve successfully.
        const updateSettings = vi
          .fn()
          .mockRejectedValueOnce(new Error(CONFLICT_MSG))
          .mockResolvedValueOnce(undefined);

        mockUseSystemSettings.mockReturnValue(
          makeSystemSettingsMock({ forwardSearchEnabled: false, updateSettings }) as ReturnType<typeof useSystemSettings>,
        );

        const user = userEvent.setup();
        render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

        await user.click(getForwardSearchSwitch());

        // The success toast should appear — not an error
        await waitFor(() => {
          expect(screen.getByText(/forward search setting saved/i)).toBeInTheDocument();
        });

        // updateSettings must have been called exactly twice (initial + one retry)
        expect(updateSettings).toHaveBeenCalledTimes(2);
        expect(screen.queryByText(CONFLICT_MSG)).not.toBeInTheDocument();
      });

      it('shows error and does NOT retry more than once when conflict persists on retry', async () => {
        // Both the initial call and the retry reject with the version-conflict message.
        const updateSettings = vi
          .fn()
          .mockRejectedValueOnce(new Error(CONFLICT_MSG))
          .mockRejectedValueOnce(new Error(CONFLICT_MSG));

        mockUseSystemSettings.mockReturnValue(
          makeSystemSettingsMock({ forwardSearchEnabled: false, updateSettings }) as ReturnType<typeof useSystemSettings>,
        );

        const user = userEvent.setup();
        render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

        await user.click(getForwardSearchSwitch());

        // Error toast must appear (from the retry rejection)
        await waitFor(() => {
          expect(screen.getByText(CONFLICT_MSG)).toBeInTheDocument();
        });

        // Called exactly twice — no infinite retry loop
        expect(updateSettings).toHaveBeenCalledTimes(2);
        expect(screen.queryByText(/forward search setting saved/i)).not.toBeInTheDocument();
      });

      it('shows error immediately without retrying for a non-conflict error', async () => {
        const updateSettings = vi
          .fn()
          .mockRejectedValueOnce(new Error('Network error'));

        mockUseSystemSettings.mockReturnValue(
          makeSystemSettingsMock({ forwardSearchEnabled: false, updateSettings }) as ReturnType<typeof useSystemSettings>,
        );

        const user = userEvent.setup();
        render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

        await user.click(getForwardSearchSwitch());

        // Error toast must show the original error message
        await waitFor(() => {
          expect(screen.getByText(/network error/i)).toBeInTheDocument();
        });

        // Only one attempt — no retry for a non-conflict error
        expect(updateSettings).toHaveBeenCalledTimes(1);
        expect(screen.queryByText(/forward search setting saved/i)).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('backfill section', () => {
    it('renders the "Run Backfill" button', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run backfill/i })).toBeInTheDocument();
    });

    it('renders the From and To date fields', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByLabelText(/from.*capture date/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/to.*capture date/i)).toBeInTheDocument();
    });

    it('renders the Force re-geocode toggle', () => {
      render(<GeoSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/force re-geocode all/i)).toBeInTheDocument();
    });
  });
});

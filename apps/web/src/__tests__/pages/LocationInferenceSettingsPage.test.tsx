/**
 * Unit tests for LocationInferenceSettingsPage (Admin > Location Inference).
 *
 * Mocking strategy:
 *   - usePermissions is module-mocked to control admin state (page redirects
 *     non-admins to /).
 *   - useSystemSettings is module-mocked to control feature flag and
 *     locationInference parameter values.
 *   - services/adminLocationInference is module-mocked
 *     (runGlobalLocationInferenceBackfill) to prevent real API calls.
 *
 * Modeled closely on DuplicatesSettingsPage.test.tsx; there is no
 * model-status indicator section on this page (that's dedup/CLIP-specific).
 *
 * Covers:
 *   - Access control: non-admins are redirected away
 *   - Page structure: heading, "Back to Settings" link, section headings
 *   - Global feature toggle: renders checked/unchecked from settings, calls
 *     updateSettings with features.locationInference on toggle
 *   - The five sliders + one switch (requireSameDevice) render values from settings
 *   - Save Parameters button calls updateSettings with the locationInference.* shape
 *   - Backfill panel: from/to date pickers + force checkbox; submits a body
 *     shaped like {from, to, force} to runGlobalLocationInferenceBackfill;
 *     displays the enqueued/estimatedItems/circles result afterward
 *   - Loading and error states
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

vi.mock('../../services/adminLocationInference', () => ({
  runGlobalLocationInferenceBackfill: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import LocationInferenceSettingsPage from '../../pages/Admin/LocationInferenceSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { runGlobalLocationInferenceBackfill } from '../../services/adminLocationInference';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockRunGlobalLocationInferenceBackfill = vi.mocked(runGlobalLocationInferenceBackfill);

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

function makeSystemSettingsMock(locationInference = false) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  return {
    settings: {
      features: {
        autoTagging: false,
        faceRecognition: false,
        burstDetection: false,
        duplicateDetection: false,
        locationInference,
      },
      locationInference: {
        maxGapMinutes: 30,
        maxExtrapolationGapMinutes: 10,
        autoApplyMaxGapMinutes: 5,
        requireSameDevice: true,
        maxAnchorDistanceKm: 2,
        maxImpliedSpeedKmh: 150,
      },
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

describe('LocationInferenceSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(adminPermissions() as any);
    mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);
  });

  // -------------------------------------------------------------------------
  describe('access control', () => {
    it('redirects non-admin users', () => {
      mockUsePermissions.mockReturnValue(nonAdminPermissions() as any);

      render(<LocationInferenceSettingsPage />);

      expect(
        screen.queryByRole('heading', { name: /location inference/i }),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('page structure', () => {
    it('renders the page heading', () => {
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        screen.getByRole('heading', { name: /location inference/i }),
      ).toBeInTheDocument();
    });

    it('renders "Back to Settings" link', () => {
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/back to settings/i)).toBeInTheDocument();
    });

    it('renders Global Settings section', () => {
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Global Settings')).toBeInTheDocument();
    });

    it('renders Inference Parameters section', () => {
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Inference Parameters')).toBeInTheDocument();
    });

    it('renders Scan All Circles backfill section', () => {
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/scan all circles for missing locations/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('global location inference toggle', () => {
    it('switch is unchecked when locationInference is false', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);

      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable location inference globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(false);
    });

    it('switch is checked when locationInference is true', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);

      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable location inference globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(true);
    });

    it('calls updateSettings with locationInference:true when switch is toggled on', async () => {
      const mock = makeSystemSettingsMock(false);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable location inference globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            features: expect.objectContaining({ locationInference: true }),
          }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('inference parameter sliders', () => {
    it('renders the max interpolation gap slider with the value from settings', () => {
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/max interpolation gap/i)).toBeInTheDocument();
      const sliders = screen.getAllByRole('slider');
      expect(sliders.find((s) => s.getAttribute('aria-valuenow') === '30')).toBeTruthy();
    });

    it('renders the max extrapolation gap slider with the value from settings', () => {
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/max extrapolation gap/i)).toBeInTheDocument();
      const sliders = screen.getAllByRole('slider');
      expect(sliders.find((s) => s.getAttribute('aria-valuenow') === '10')).toBeTruthy();
    });

    it('renders the auto-apply gap ceiling slider with the value from settings', () => {
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/auto-apply gap ceiling/i)).toBeInTheDocument();
      const sliders = screen.getAllByRole('slider');
      expect(sliders.find((s) => s.getAttribute('aria-valuenow') === '5')).toBeTruthy();
    });

    it('renders the max anchor disagreement slider with the value from settings', () => {
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/max anchor disagreement/i)).toBeInTheDocument();
      const sliders = screen.getAllByRole('slider');
      expect(sliders.find((s) => s.getAttribute('aria-valuenow') === '2')).toBeTruthy();
    });

    it('renders the max implied speed slider with the value from settings', () => {
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/max implied speed/i)).toBeInTheDocument();
      const sliders = screen.getAllByRole('slider');
      expect(sliders.find((s) => s.getAttribute('aria-valuenow') === '150')).toBeTruthy();
    });

    it('renders the "Require matching camera make/model between anchors" switch, checked by default', () => {
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/require matching camera make\/model between anchors/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(true);
    });

    it('renders the "Save Parameters" button', () => {
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /save parameters/i })).toBeInTheDocument();
    });

    it('calls updateSettings with the locationInference.* shape when Save Parameters is clicked', async () => {
      const mock = makeSystemSettingsMock(true);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /save parameters/i }));

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith({
          locationInference: {
            maxGapMinutes: expect.any(Number),
            maxExtrapolationGapMinutes: expect.any(Number),
            autoApplyMaxGapMinutes: expect.any(Number),
            requireSameDevice: expect.any(Boolean),
            maxAnchorDistanceKm: expect.any(Number),
            maxImpliedSpeedKmh: expect.any(Number),
          },
        });
      });
    });

    it('shows success message after saving parameters', async () => {
      const mock = makeSystemSettingsMock(true);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /save parameters/i }));

      await waitFor(() => {
        expect(screen.getByText(/location inference parameters saved/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('global backfill panel', () => {
    it('backfill button is disabled when locationInference is false', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);

      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run global location scan/i })).toBeDisabled();
    });

    it('backfill button is enabled when locationInference is true', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);

      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run global location scan/i })).not.toBeDisabled();
    });

    it('submits {from, to, force} shaped body to runGlobalLocationInferenceBackfill', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalLocationInferenceBackfill.mockResolvedValue({ enqueued: 4, circles: 2, estimatedItems: 400 });

      const user = userEvent.setup();
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.type(screen.getByLabelText(/from date/i), '2026-01-01');
      await user.type(screen.getByLabelText(/to date/i), '2026-06-01');
      await user.click(screen.getByLabelText(/force/i));

      await user.click(screen.getByRole('button', { name: /run global location scan/i }));

      await waitFor(() => {
        expect(mockRunGlobalLocationInferenceBackfill).toHaveBeenCalledWith({
          from: '2026-01-01',
          to: '2026-06-01',
          force: true,
        });
      });
    });

    it('submits undefined from/to and force:false when fields are left blank', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalLocationInferenceBackfill.mockResolvedValue({ enqueued: 4, circles: 2, estimatedItems: 400 });

      const user = userEvent.setup();
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /run global location scan/i }));

      await waitFor(() => {
        expect(mockRunGlobalLocationInferenceBackfill).toHaveBeenCalledWith({
          from: undefined,
          to: undefined,
          force: false,
        });
      });
    });

    it('displays the enqueued/estimatedItems/circles result after a successful scan', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalLocationInferenceBackfill.mockResolvedValue({ enqueued: 3, circles: 3, estimatedItems: 1150 });

      const user = userEvent.setup();
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /run global location scan/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/3 sweep jobs queued covering ~1150 photos across 3 circles/i),
        ).toBeInTheDocument();
      });
    });

    it('uses singular wording when enqueued/estimatedItems/circles are each 1', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalLocationInferenceBackfill.mockResolvedValue({ enqueued: 1, circles: 1, estimatedItems: 1 });

      const user = userEvent.setup();
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /run global location scan/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/1 sweep job queued covering ~1 photo across 1 circle\./i),
        ).toBeInTheDocument();
      });
    });

    it('shows error alert when backfill fails', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalLocationInferenceBackfill.mockRejectedValue(new Error('Queue unavailable'));

      const user = userEvent.setup();
      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /run global location scan/i }));

      await waitFor(() => {
        expect(screen.getByText(/queue unavailable/i)).toBeInTheDocument();
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

      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

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

      render(<LocationInferenceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });
});

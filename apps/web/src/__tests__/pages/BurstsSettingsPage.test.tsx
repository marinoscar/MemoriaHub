/**
 * Unit tests for BurstsSettingsPage.
 *
 * Mocking strategy:
 *   - usePermissions is module-mocked to control admin state.
 *   - useSystemSettings is module-mocked to control feature flag and burst parameter values.
 *   - services/adminBackfill is module-mocked to prevent real API calls.
 *
 * The page redirects non-admins to /. Admins see:
 *   - A global "Enable burst photo detection" switch (features.burstDetection).
 *   - Burst detection parameters (timeGapSeconds, hashDistance, minGroupSize).
 *   - A "Run Global Burst Scan" button (disabled when burstDetection is false).
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

vi.mock('../../services/adminBackfill', () => ({
  runGlobalBurstBackfill: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import BurstsSettingsPage from '../../pages/Admin/BurstsSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { runGlobalBurstBackfill } from '../../services/adminBackfill';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockRunGlobalBurstBackfill = vi.mocked(runGlobalBurstBackfill);

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

function makeSystemSettingsMock(burstDetection = false, autoResolveThreshold = 60) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  return {
    settings: {
      features: { autoTagging: false, faceRecognition: false, burstDetection },
      burst: { timeGapSeconds: 10, hashDistance: 10, minGroupSize: 3, autoResolveThreshold },
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

describe('BurstsSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(adminPermissions() as any);
    mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);
  });

  // -------------------------------------------------------------------------
  describe('access control', () => {
    it('redirects non-admin users', () => {
      mockUsePermissions.mockReturnValue(nonAdminPermissions() as any);

      render(<BurstsSettingsPage />);

      expect(
        screen.queryByRole('heading', { name: /bursts/i }),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('page structure', () => {
    it('renders the page heading', () => {
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        screen.getByRole('heading', { name: /bursts & similar pictures/i }),
      ).toBeInTheDocument();
    });

    it('renders "Back to Settings" link', () => {
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/back to settings/i)).toBeInTheDocument();
    });

    it('renders Global Settings section', () => {
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Global Settings')).toBeInTheDocument();
    });

    it('renders Burst Detection Parameters section', () => {
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Burst Detection Parameters')).toBeInTheDocument();
    });

    it('renders Scan All Circles backfill section', () => {
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/scan all circles/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('global burst detection toggle', () => {
    it('switch is unchecked when burstDetection is false', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);

      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable burst photo detection globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(false);
    });

    it('switch is checked when burstDetection is true', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);

      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable burst photo detection globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(true);
    });

    it('calls updateSettings with burstDetection:true when switch is toggled on', async () => {
      const mock = makeSystemSettingsMock(false);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable burst photo detection globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            features: expect.objectContaining({ burstDetection: true }),
          }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('burst detection parameters', () => {
    it('renders the Time gap field pre-filled from settings', () => {
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const timeGapInput = screen.getByLabelText(/time gap/i) as HTMLInputElement;
      expect(timeGapInput.value).toBe('10');
    });

    it('renders the Hash distance field pre-filled from settings', () => {
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const hashDistInput = screen.getByLabelText(/hash distance/i) as HTMLInputElement;
      expect(hashDistInput.value).toBe('10');
    });

    it('renders the Min group size field pre-filled from settings', () => {
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const minGroupInput = screen.getByLabelText(/min group size/i) as HTMLInputElement;
      expect(minGroupInput.value).toBe('3');
    });

    it('renders "Save Parameters" button', () => {
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /save parameters/i })).toBeInTheDocument();
    });

    it('renders the Auto-resolve threshold field pre-filled from settings', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false, 75) as any);

      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const thresholdInput = screen.getByLabelText(/auto-resolve threshold/i) as HTMLInputElement;
      expect(thresholdInput.value).toBe('75');
    });

    it('defaults the Auto-resolve threshold field to 60 when unset', () => {
      mockUseSystemSettings.mockReturnValue({
        ...makeSystemSettingsMock(false),
        settings: {
          features: { autoTagging: false, faceRecognition: false, burstDetection: false },
          burst: { timeGapSeconds: 10, hashDistance: 10, minGroupSize: 3 },
          ui: { allowUserThemeOverride: true },
          updatedAt: new Date().toISOString(),
          updatedBy: null,
          version: 1,
        },
      } as any);

      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const thresholdInput = screen.getByLabelText(/auto-resolve threshold/i) as HTMLInputElement;
      expect(thresholdInput.value).toBe('60');
    });

    it('calls updateSettings with burst params (including autoResolveThreshold) when Save Parameters is clicked', async () => {
      const mock = makeSystemSettingsMock(true, 80);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /save parameters/i }));

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            burst: expect.objectContaining({
              timeGapSeconds: expect.any(Number),
              hashDistance: expect.any(Number),
              minGroupSize: expect.any(Number),
              autoResolveThreshold: 80,
            }),
          }),
        );
      });
    });

    it('saves an edited Auto-resolve threshold value', async () => {
      const mock = makeSystemSettingsMock(true, 60);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const thresholdInput = screen.getByLabelText(/auto-resolve threshold/i);
      await user.clear(thresholdInput);
      await user.type(thresholdInput, '85');

      await user.click(screen.getByRole('button', { name: /save parameters/i }));

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            burst: expect.objectContaining({ autoResolveThreshold: 85 }),
          }),
        );
      });
    });

    it('shows success message after saving parameters', async () => {
      const mock = makeSystemSettingsMock(true);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /save parameters/i }));

      await waitFor(() => {
        expect(screen.getByText(/burst detection parameters saved/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('global burst scan button', () => {
    it('renders "Run Global Burst Scan" button', () => {
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run global burst scan/i })).toBeInTheDocument();
    });

    it('backfill button is disabled when burstDetection is false', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);

      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run global burst scan/i })).toBeDisabled();
    });

    it('backfill button is enabled when burstDetection is true', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);

      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run global burst scan/i })).not.toBeDisabled();
    });

    it('calls runGlobalBurstBackfill when button is clicked', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalBurstBackfill.mockResolvedValue({ enqueued: 4, circles: 2 });

      const user = userEvent.setup();
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /run global burst scan/i }));

      await waitFor(() => {
        expect(mockRunGlobalBurstBackfill).toHaveBeenCalledTimes(1);
      });
    });

    it('shows success message with enqueued count after burst scan', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalBurstBackfill.mockResolvedValue({ enqueued: 12, circles: 4 });

      const user = userEvent.setup();
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /run global burst scan/i }));

      await waitFor(() => {
        expect(screen.getByText(/12 jobs queued across 4 circle/i)).toBeInTheDocument();
      });
    });

    it('shows error alert when backfill fails', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalBurstBackfill.mockRejectedValue(new Error('Queue unavailable'));

      const user = userEvent.setup();
      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /run global burst scan/i }));

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

      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

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

      render(<BurstsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });
});

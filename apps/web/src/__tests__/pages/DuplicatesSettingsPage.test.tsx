/**
 * Unit tests for DuplicatesSettingsPage (Admin > Near-Duplicate Detection).
 *
 * Mocking strategy:
 *   - usePermissions is module-mocked to control admin state (page redirects
 *     non-admins to /).
 *   - useSystemSettings is module-mocked to control feature flag and dedup
 *     parameter values.
 *   - services/adminDuplicates is module-mocked (runGlobalDuplicatesBackfill,
 *     getDuplicatesStatus) to prevent real API calls.
 *
 * Covers:
 *   - Access control: non-admins are redirected away
 *   - Page structure: heading, "Back to Settings" link, section headings
 *   - Global feature toggle: renders checked/unchecked from settings, calls
 *     updateSettings with features.duplicateDetection on toggle
 *   - Matching parameter sliders render with values from settings
 *   - Save Parameters button calls updateSettings with the dedup.* shape
 *   - Backfill panel: from/to date pickers + force checkbox; submits a body
 *     shaped like {from, to, force} to runGlobalDuplicatesBackfill; displays
 *     the enqueued/estimatedItems/circles result afterward
 *   - Model status indicator: renders available vs degraded states
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

vi.mock('../../services/adminDuplicates', () => ({
  runGlobalDuplicatesBackfill: vi.fn(),
  getDuplicatesStatus: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import DuplicatesSettingsPage from '../../pages/Admin/DuplicatesSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { runGlobalDuplicatesBackfill, getDuplicatesStatus } from '../../services/adminDuplicates';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockRunGlobalDuplicatesBackfill = vi.mocked(runGlobalDuplicatesBackfill);
const mockGetDuplicatesStatus = vi.mocked(getDuplicatesStatus);

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

function makeSystemSettingsMock(duplicateDetection = false, autoResolveThreshold = 60) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  return {
    settings: {
      features: { autoTagging: false, faceRecognition: false, burstDetection: false, duplicateDetection },
      dedup: { similarityThreshold: 0.96, hashMaxDistance: 6, knnCandidates: 20, autoResolveThreshold },
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

function makeModelStatus(overrides: Partial<{ modelAvailable: boolean; modelPath: string; degraded: boolean; model: string }> = {}) {
  return {
    modelAvailable: true,
    modelPath: '/data/models/clip-vit-b32-vision-quantized.onnx',
    degraded: false,
    model: 'clip-vit-b32-q8',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DuplicatesSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(adminPermissions() as any);
    mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);
    mockGetDuplicatesStatus.mockResolvedValue(makeModelStatus());
  });

  // -------------------------------------------------------------------------
  describe('access control', () => {
    it('redirects non-admin users', () => {
      mockUsePermissions.mockReturnValue(nonAdminPermissions() as any);

      render(<DuplicatesSettingsPage />);

      expect(
        screen.queryByRole('heading', { name: /near-duplicate detection/i }),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('page structure', () => {
    it('renders the page heading', () => {
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        screen.getByRole('heading', { name: /near-duplicate detection/i }),
      ).toBeInTheDocument();
    });

    it('renders "Back to Settings" link', () => {
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/back to settings/i)).toBeInTheDocument();
    });

    it('renders Global Settings section', () => {
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Global Settings')).toBeInTheDocument();
    });

    it('renders Matching Parameters section', () => {
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Matching Parameters')).toBeInTheDocument();
    });

    it('renders Scan All Circles backfill section', () => {
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/scan all circles for duplicates/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('global duplicate detection toggle', () => {
    it('switch is unchecked when duplicateDetection is false', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);

      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable near-duplicate detection globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(false);
    });

    it('switch is checked when duplicateDetection is true', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);

      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable near-duplicate detection globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(true);
    });

    it('calls updateSettings with duplicateDetection:true when switch is toggled on', async () => {
      const mock = makeSystemSettingsMock(false);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable near-duplicate detection globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            features: expect.objectContaining({ duplicateDetection: true }),
          }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('matching parameter sliders', () => {
    it('renders the similarity threshold slider with the value from settings', () => {
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/similarity threshold/i)).toBeInTheDocument();
      const sliders = screen.getAllByRole('slider');
      const similaritySlider = sliders.find((s) => s.getAttribute('aria-valuenow') === '0.96');
      expect(similaritySlider).toBeTruthy();
    });

    it('renders the hash max distance slider with the value from settings', () => {
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/hash max distance/i)).toBeInTheDocument();
      const sliders = screen.getAllByRole('slider');
      const hashSlider = sliders.find((s) => s.getAttribute('aria-valuenow') === '6');
      expect(hashSlider).toBeTruthy();
    });

    it('renders the KNN candidates slider with the value from settings', () => {
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/knn candidates/i)).toBeInTheDocument();
      const sliders = screen.getAllByRole('slider');
      const knnSlider = sliders.find((s) => s.getAttribute('aria-valuenow') === '20');
      expect(knnSlider).toBeTruthy();
    });

    it('renders the "Save Parameters" button', () => {
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /save parameters/i })).toBeInTheDocument();
    });

    it('renders the auto-resolve threshold slider with the value from settings', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false, 80) as any);

      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/auto-resolve threshold/i)).toBeInTheDocument();
      const sliders = screen.getAllByRole('slider');
      const thresholdSlider = sliders.find((s) => s.getAttribute('aria-valuenow') === '80');
      expect(thresholdSlider).toBeTruthy();
    });

    it('defaults the auto-resolve threshold slider to 60 when unset', () => {
      mockUseSystemSettings.mockReturnValue({
        ...makeSystemSettingsMock(false),
        settings: {
          features: { autoTagging: false, faceRecognition: false, burstDetection: false, duplicateDetection: false },
          dedup: { similarityThreshold: 0.96, hashMaxDistance: 6, knnCandidates: 20 },
          ui: { allowUserThemeOverride: true },
          updatedAt: new Date().toISOString(),
          updatedBy: null,
          version: 1,
        },
      } as any);

      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const sliders = screen.getAllByRole('slider');
      const thresholdSlider = sliders.find((s) => s.getAttribute('aria-valuenow') === '60');
      expect(thresholdSlider).toBeTruthy();
    });

    it('calls updateSettings with dedup params (including autoResolveThreshold) when Save Parameters is clicked', async () => {
      const mock = makeSystemSettingsMock(true, 80);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /save parameters/i }));

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            dedup: {
              similarityThreshold: expect.any(Number),
              hashMaxDistance: expect.any(Number),
              knnCandidates: expect.any(Number),
              autoResolveThreshold: 80,
            },
          }),
        );
      });
    });

    it('shows success message after saving parameters', async () => {
      const mock = makeSystemSettingsMock(true);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /save parameters/i }));

      await waitFor(() => {
        expect(screen.getByText(/duplicate detection parameters saved/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('global backfill panel', () => {
    it('backfill button is disabled when duplicateDetection is false', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);

      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run global duplicate scan/i })).toBeDisabled();
    });

    it('backfill button is enabled when duplicateDetection is true', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);

      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run global duplicate scan/i })).not.toBeDisabled();
    });

    it('submits {from, to, force} shaped body to runGlobalDuplicatesBackfill', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalDuplicatesBackfill.mockResolvedValue({ enqueued: 4, circles: 2, estimatedItems: 400 });

      const user = userEvent.setup();
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.type(screen.getByLabelText(/from date/i), '2026-01-01');
      await user.type(screen.getByLabelText(/to date/i), '2026-06-01');
      await user.click(screen.getByLabelText(/force/i));

      await user.click(screen.getByRole('button', { name: /run global duplicate scan/i }));

      await waitFor(() => {
        expect(mockRunGlobalDuplicatesBackfill).toHaveBeenCalledWith({
          from: '2026-01-01',
          to: '2026-06-01',
          force: true,
        });
      });
    });

    it('submits undefined from/to and force:false when fields are left blank', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalDuplicatesBackfill.mockResolvedValue({ enqueued: 4, circles: 2, estimatedItems: 400 });

      const user = userEvent.setup();
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /run global duplicate scan/i }));

      await waitFor(() => {
        expect(mockRunGlobalDuplicatesBackfill).toHaveBeenCalledWith({
          from: undefined,
          to: undefined,
          force: false,
        });
      });
    });

    it('displays the enqueued/estimatedItems/circles result after a successful scan', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalDuplicatesBackfill.mockResolvedValue({ enqueued: 12, circles: 4, estimatedItems: 1150 });

      const user = userEvent.setup();
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /run global duplicate scan/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/12 jobs queued covering ~1150 photos across 4 circles/i),
        ).toBeInTheDocument();
      });
    });

    it('shows error alert when backfill fails', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalDuplicatesBackfill.mockRejectedValue(new Error('Queue unavailable'));

      const user = userEvent.setup();
      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /run global duplicate scan/i }));

      await waitFor(() => {
        expect(screen.getByText(/queue unavailable/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('model status indicator', () => {
    it('shows the model-available message when the model is loaded', async () => {
      mockGetDuplicatesStatus.mockResolvedValue(
        makeModelStatus({ degraded: false, model: 'clip-vit-b32-q8' }),
      );

      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/is loaded and available/i)).toBeInTheDocument();
      });
    });

    it('shows the degraded warning message when the model is unavailable', async () => {
      mockGetDuplicatesStatus.mockResolvedValue(
        makeModelStatus({ degraded: true, modelPath: '/data/models/missing.onnx' }),
      );

      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/degraded \(hash-only\) mode/i)).toBeInTheDocument();
      });
    });

    it('shows a warning alert when the model status fetch fails', async () => {
      mockGetDuplicatesStatus.mockRejectedValue(new Error('Status unavailable'));

      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('Status unavailable')).toBeInTheDocument();
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

      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

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

      render(<DuplicatesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });
});

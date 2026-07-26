/**
 * Unit tests for EnhancerSettingsPage (Admin > AI Picture Enhancer).
 *
 * Mocking strategy (modeled closely on LocationInferenceSettingsPage.test.tsx):
 *   - usePermissions is module-mocked to control admin state (page redirects
 *     non-admins to /).
 *   - useSystemSettings is module-mocked to control the feature flag and the
 *     seven pictureEnhancement.* knobs.
 *   - services/enhance's getEnhancerAdminStatus is module-mocked to drive the
 *     Readiness panel (ready / not-ready with each failing reason).
 *
 * Covers:
 *   - Access control: non-admins are redirected away
 *   - Master toggle: PATCH payload spreads existing features and sets
 *     pictureEnhancement
 *   - The 7 pictureEnhancement.* knobs: Save Settings sends the spread +
 *     overwrite shape
 *   - Readiness panel: ready state, and not-ready state listing every
 *     failing reason (toggle off / no model / no credential)
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

vi.mock('../../services/enhance', () => ({
  getEnhancerAdminStatus: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import EnhancerSettingsPage from '../../pages/Admin/EnhancerSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { getEnhancerAdminStatus } from '../../services/enhance';
import type { EnhancerAdminStatus } from '../../services/enhance';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockGetEnhancerAdminStatus = vi.mocked(getEnhancerAdminStatus);

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

function makeSystemSettingsMock(pictureEnhancement = false) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  return {
    settings: {
      features: {
        autoTagging: false,
        faceRecognition: false,
        burstDetection: false,
        duplicateDetection: false,
        locationInference: false,
        pictureEnhancement,
      },
      pictureEnhancement: {
        defaultQuality: 'high',
        defaultStrength: 'balanced',
        stampExif: true,
        allowReplace: true,
        blockReplaceOnDownscale: false,
        maxInputMegapixels: 50,
        retentionHours: 72,
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

function makeAdminStatus(overrides: Partial<EnhancerAdminStatus> = {}): EnhancerAdminStatus {
  return {
    featureEnabled: true,
    provider: 'openai',
    model: 'gpt-image-1',
    credentialConfigured: true,
    ready: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnhancerSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(adminPermissions() as any);
    mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);
    mockGetEnhancerAdminStatus.mockResolvedValue(makeAdminStatus());
  });

  // -------------------------------------------------------------------------
  describe('access control', () => {
    it('redirects non-admin users', () => {
      mockUsePermissions.mockReturnValue(nonAdminPermissions() as any);

      render(<EnhancerSettingsPage />);

      expect(
        screen.queryByRole('heading', { name: /ai picture enhancer/i }),
      ).not.toBeInTheDocument();
    });

    it('redirects a user with admin role but without system_settings:read', () => {
      mockUsePermissions.mockReturnValue({
        ...adminPermissions(),
        hasPermission: vi.fn().mockReturnValue(false),
      } as any);

      render(<EnhancerSettingsPage />);

      expect(
        screen.queryByRole('heading', { name: /ai picture enhancer/i }),
      ).not.toBeInTheDocument();
    });

    it('renders the page for an admin with system_settings:read', () => {
      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        screen.getByRole('heading', { name: /ai picture enhancer/i }),
      ).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('master toggle', () => {
    it('switch is unchecked when features.pictureEnhancement is false', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);

      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable ai picture enhancement globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(false);
    });

    it('switch is checked when features.pictureEnhancement is true', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);

      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable ai picture enhancement globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(true);
    });

    it('sends a PATCH that spreads existing features and sets pictureEnhancement:true', async () => {
      const mock = makeSystemSettingsMock(false);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable ai picture enhancement globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith({
          features: {
            autoTagging: false,
            faceRecognition: false,
            burstDetection: false,
            duplicateDetection: false,
            locationInference: false,
            pictureEnhancement: true,
          },
        });
      });
    });

    it('refreshes the readiness panel after the toggle is saved', async () => {
      const mock = makeSystemSettingsMock(false);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => expect(mockGetEnhancerAdminStatus).toHaveBeenCalledTimes(1));

      const label = screen.getByText(/enable ai picture enhancement globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(mockGetEnhancerAdminStatus).toHaveBeenCalledTimes(2);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('the 7 pictureEnhancement.* knobs', () => {
    it('renders defaults from settings', () => {
      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/carry exif metadata onto the enhanced file/i)).toBeInTheDocument();
      expect(screen.getByText(/allow replacing the original/i)).toBeInTheDocument();
      expect(
        screen.getByText(/block replace when the result is lower resolution/i),
      ).toBeInTheDocument();
      expect(screen.getByLabelText(/max input megapixels/i)).toHaveValue(50);
      expect(screen.getByLabelText(/preview retention \(hours\)/i)).toHaveValue(72);
    });

    it('saves the spread + overwrite shape when Save Settings is clicked without changes', async () => {
      const mock = makeSystemSettingsMock(true);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /save settings/i }));

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith({
          pictureEnhancement: {
            defaultQuality: 'high',
            defaultStrength: 'balanced',
            stampExif: true,
            allowReplace: true,
            blockReplaceOnDownscale: false,
            maxInputMegapixels: 50,
            retentionHours: 72,
          },
        });
      });
    });

    it('saves edited values for all 7 knobs', async () => {
      const mock = makeSystemSettingsMock(true);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // defaultQuality select -> low
      await user.click(screen.getByLabelText(/default quality/i));
      await user.click(await screen.findByRole('option', { name: /^low$/i }));

      // defaultStrength select -> subtle
      await user.click(screen.getByLabelText(/default strength/i));
      await user.click(await screen.findByRole('option', { name: /^subtle$/i }));

      // toggles off
      await user.click(
        screen
          .getByText(/carry exif metadata onto the enhanced file/i)
          .closest('.MuiFormControlLabel-root')!.querySelector('input[type="checkbox"]')!,
      );
      await user.click(
        screen
          .getByText(/^allow replacing the original$/i)
          .closest('.MuiFormControlLabel-root')!.querySelector('input[type="checkbox"]')!,
      );

      // numeric fields
      const megapixels = screen.getByLabelText(/max input megapixels/i);
      await user.clear(megapixels);
      await user.type(megapixels, '25');

      const retention = screen.getByLabelText(/preview retention \(hours\)/i);
      await user.clear(retention);
      await user.type(retention, '48');

      await user.click(screen.getByRole('button', { name: /save settings/i }));

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith({
          pictureEnhancement: {
            defaultQuality: 'low',
            defaultStrength: 'subtle',
            stampExif: false,
            allowReplace: false,
            blockReplaceOnDownscale: false,
            maxInputMegapixels: 25,
            retentionHours: 48,
          },
        });
      });
    });

    it('disables Save Settings when max input megapixels is out of range', async () => {
      const mock = makeSystemSettingsMock(true);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const megapixels = screen.getByLabelText(/max input megapixels/i);
      await user.clear(megapixels);
      await user.type(megapixels, '999');

      expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
    });

    it('disables Save Settings when retention hours is out of range', async () => {
      const mock = makeSystemSettingsMock(true);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const retention = screen.getByLabelText(/preview retention \(hours\)/i);
      await user.clear(retention);
      await user.type(retention, '0');

      expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  describe('readiness panel', () => {
    it('shows the ready state when the feature is on, and a model + credential are configured', async () => {
      mockGetEnhancerAdminStatus.mockResolvedValue(
        makeAdminStatus({ featureEnabled: true, provider: 'openai', model: 'gpt-image-1', credentialConfigured: true, ready: true }),
      );

      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('Ready')).toBeInTheDocument();
      });
      expect(screen.getByText(/feature: enabled/i)).toBeInTheDocument();
      expect(screen.getByText(/provider: openai/i)).toBeInTheDocument();
      expect(screen.getByText(/model: gpt-image-1/i)).toBeInTheDocument();
      expect(screen.getByText(/credential: configured/i)).toBeInTheDocument();
    });

    it('shows the not-ready state and lists every failing reason', async () => {
      mockGetEnhancerAdminStatus.mockResolvedValue(
        makeAdminStatus({
          featureEnabled: false,
          provider: null,
          model: null,
          credentialConfigured: false,
          ready: false,
        }),
      );

      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('Not ready')).toBeInTheDocument();
      });

      // Toggle-off reason
      expect(
        screen.getByText(/the global toggle above is off/i),
      ).toBeInTheDocument();
      // No-model reason
      expect(screen.getByText(/no image model is selected/i)).toBeInTheDocument();
      // No-credential reason
      expect(
        screen.getByText(/no enabled credential for the image provider/i),
      ).toBeInTheDocument();
    });

    it('lists only the missing-credential reason when the feature is on and a model is set but no credential exists', async () => {
      mockGetEnhancerAdminStatus.mockResolvedValue(
        makeAdminStatus({
          featureEnabled: true,
          provider: 'openai',
          model: 'gpt-image-1',
          credentialConfigured: false,
          ready: false,
        }),
      );

      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('Not ready')).toBeInTheDocument();
      });

      expect(
        screen.queryByText(/the global toggle above is off/i),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/no image model is selected/i)).not.toBeInTheDocument();
      expect(screen.getByText(/no enabled credential for/i)).toBeInTheDocument();
    });

    it('shows a warning alert with a retry button when the status fetch fails', async () => {
      mockGetEnhancerAdminStatus.mockRejectedValue(new Error('Network error'));

      const user = userEvent.setup();
      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });

      mockGetEnhancerAdminStatus.mockResolvedValueOnce(makeAdminStatus());
      await user.click(screen.getByRole('button', { name: /retry/i }));

      await waitFor(() => {
        expect(screen.getByText('Ready')).toBeInTheDocument();
      });
    });

    it('calls getEnhancerAdminStatus again when Refresh is clicked', async () => {
      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => expect(mockGetEnhancerAdminStatus).toHaveBeenCalledTimes(1));

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /^refresh$/i }));

      await waitFor(() => {
        expect(mockGetEnhancerAdminStatus).toHaveBeenCalledTimes(2);
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

      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

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

      render(<EnhancerSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });
});

/**
 * Unit tests for TaggingSettingsPage.
 *
 * Mocking strategy:
 *   - usePermissions is module-mocked to control admin state.
 *   - useSystemSettings is module-mocked to control feature flag values.
 *   - services/adminBackfill is module-mocked to prevent real API calls.
 *   - TagsContent (embedded from TagsPage) is module-mocked to avoid rendering
 *     the full tag vocabulary table in these tests.
 *
 * The page redirects non-admins to /. Admins see:
 *   - A global "Enable AI auto-tagging" switch driven by useSystemSettings.
 *   - A "Run Global Backfill" button (disabled when autoTagging is false).
 *   - "Back to Settings" breadcrumb link.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — must be before consuming imports
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

vi.mock('../../services/adminBackfill', () => ({
  runGlobalTaggingBackfill: vi.fn(),
}));

// Mock TagsContent to avoid rendering the full tag vocabulary in these tests
vi.mock('../../pages/Admin/TagsPage', () => ({
  TagsContent: () => <div data-testid="mock-tags-content">Tags Content</div>,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import TaggingSettingsPage from '../../pages/Admin/TaggingSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { runGlobalTaggingBackfill } from '../../services/adminBackfill';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockRunGlobalTaggingBackfill = vi.mocked(runGlobalTaggingBackfill);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminPermissions() {
  return {
    isAdmin: true,
    permissions: new Set(['ai_settings:read', 'ai_settings:write']),
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

function makeSystemSettingsMock(autoTagging = false) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  return {
    settings: {
      features: { autoTagging, faceRecognition: false, burstDetection: false },
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

describe('TaggingSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(adminPermissions() as any);
    mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);
  });

  // -------------------------------------------------------------------------
  describe('access control', () => {
    it('redirects non-admin users (renders nothing from the page)', () => {
      mockUsePermissions.mockReturnValue(nonAdminPermissions() as any);

      render(<TaggingSettingsPage />);

      expect(screen.queryByRole('heading', { name: /ai tagging/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('page structure', () => {
    it('renders the page heading', () => {
      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('heading', { name: /ai tagging/i })).toBeInTheDocument();
    });

    it('renders "Back to Settings" link', () => {
      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/back to settings/i)).toBeInTheDocument();
    });

    it('renders the Global Settings section heading', () => {
      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Global Settings')).toBeInTheDocument();
    });

    it('renders the embedded TagsContent', () => {
      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByTestId('mock-tags-content')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('global auto-tagging toggle', () => {
    it('renders the global auto-tagging switch', () => {
      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // MUI Switch renders with role="switch"
      const switches = screen.getAllByRole('switch');
      expect(switches.length).toBeGreaterThan(0);
    });

    it('switch is unchecked when autoTagging is false', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);

      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // The switch label text
      const label = screen.getByText(/enable ai auto-tagging/i);
      expect(label).toBeInTheDocument();

      // The associated switch checkbox should be unchecked
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(false);
    });

    it('switch is checked when autoTagging is true', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);

      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable ai auto-tagging/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(true);
    });

    it('calls updateSettings with autoTagging:true when switch is toggled on', async () => {
      const mock = makeSystemSettingsMock(false);
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const label = screen.getByText(/enable ai auto-tagging/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            features: expect.objectContaining({ autoTagging: true }),
          }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('global backfill button', () => {
    it('renders the "Run Global Backfill" button', () => {
      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run global backfill/i })).toBeInTheDocument();
    });

    it('backfill button is disabled when autoTagging is false', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(false) as any);

      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run global backfill/i })).toBeDisabled();
    });

    it('backfill button is enabled when autoTagging is true', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);

      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run global backfill/i })).not.toBeDisabled();
    });

    it('calls runGlobalTaggingBackfill when button is clicked', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalTaggingBackfill.mockResolvedValue({ enqueued: 5, circles: 2 });

      const user = userEvent.setup();
      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /run global backfill/i }));

      await waitFor(() => {
        expect(mockRunGlobalTaggingBackfill).toHaveBeenCalledTimes(1);
      });
    });

    it('shows success message with enqueued count after backfill', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalTaggingBackfill.mockResolvedValue({ enqueued: 7, circles: 3 });

      const user = userEvent.setup();
      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /run global backfill/i }));

      await waitFor(() => {
        expect(screen.getByText(/7 jobs queued across 3 circle/i)).toBeInTheDocument();
      });
    });

    it('shows error alert when backfill fails', async () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock(true) as any);
      mockRunGlobalTaggingBackfill.mockRejectedValue(new Error('Service unavailable'));

      const user = userEvent.setup();
      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /run global backfill/i }));

      await waitFor(() => {
        expect(screen.getByText(/service unavailable/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('loading state', () => {
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

      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

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

      render(<TaggingSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });
});

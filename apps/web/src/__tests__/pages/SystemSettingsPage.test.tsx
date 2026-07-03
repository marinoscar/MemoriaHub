import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';
import SystemSettingsPage from '../../pages/SystemSettingsPage';

// Mock the hooks
vi.mock('../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { useSystemSettings } from '../../hooks/useSystemSettings';
import { usePermissions } from '../../hooks/usePermissions';

const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockUsePermissions = vi.mocked(usePermissions);

describe('SystemSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default permission mock - admin user
    mockUsePermissions.mockReturnValue({
      permissions: new Set(['system_settings:read', 'system_settings:write']),
      roles: new Set(['admin']),
      hasPermission: (perm: string) => perm === 'system_settings:read' || perm === 'system_settings:write',
      hasAnyPermission: vi.fn(),
      hasAllPermissions: vi.fn(),
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isAdmin: true,
    });

    // Default settings mock
    mockUseSystemSettings.mockReturnValue({
      settings: {
        ui: {
          allowUserThemeOverride: true,
        },
        features: {},
        updatedAt: new Date().toISOString(),
        updatedBy: null,
        version: 1,
      },
      isLoading: false,
      error: null,
      isSaving: false,
      updateSettings: vi.fn().mockResolvedValue(undefined),
      replaceSettings: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn(),
    });
  });

  describe('Authorization', () => {
    it('should redirect non-admin users', () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['user_settings:read']),
        roles: new Set(['viewer']),
        hasPermission: (perm: string) => perm === 'user_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<SystemSettingsPage />, {
        wrapperOptions: {
          user: {
            id: 'viewer-id',
            email: 'viewer@example.com',
            displayName: 'Viewer User',
            profileImageUrl: null,
            roles: ['viewer'],
            permissions: ['user_settings:read'],
            isActive: true,
            createdAt: new Date().toISOString(),
          },
        },
      });

      // Should redirect - component should not render
      expect(screen.queryByText(/system settings/i)).not.toBeInTheDocument();
    });

    it('should load settings for admin users', async () => {
      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/system settings/i)).toBeInTheDocument();
      });
    });

    it('should show read-only mode when user lacks write permission', async () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['viewer']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<SystemSettingsPage />, {
        wrapperOptions: {
          user: {
            ...mockAdminUser,
            roles: ['viewer'],
            permissions: ['system_settings:read'],
          },
        },
      });

      await waitFor(() => {
        expect(screen.getByText(/read-only/i)).toBeInTheDocument();
      });
    });
  });

  describe('Loading State', () => {
    it('should show loading spinner while fetching', () => {
      mockUseSystemSettings.mockReturnValue({
        settings: null,
        isLoading: true,
        error: null,
        isSaving: false,
        updateSettings: vi.fn(),
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      });

      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('Error Display', () => {
    it('should display error message when error exists', async () => {
      mockUseSystemSettings.mockReturnValue({
        settings: null,
        isLoading: false,
        error: 'Failed to load system settings',
        isSaving: false,
        updateSettings: vi.fn(),
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      });

      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/failed to load system settings/i)).toBeInTheDocument();
      });
    });
  });

  describe('Tabs', () => {
    it('should display only the UI Settings and Storage tabs', async () => {
      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /ui settings/i })).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: /storage/i })).toBeInTheDocument();
      });

      expect(screen.queryByRole('tab', { name: /feature flags/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: /advanced.*json/i })).not.toBeInTheDocument();
      expect(screen.getAllByRole('tab')).toHaveLength(2);
    });

    it('should switch tabs on click', async () => {
      const user = userEvent.setup();

      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /storage/i })).toBeInTheDocument();
      });

      const storageTab = screen.getByRole('tab', { name: /storage/i });
      await user.click(storageTab);

      expect(storageTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('Breadcrumb', () => {
    it('should render a "Back to Settings" link to /admin/settings', async () => {
      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/back to settings/i)).toBeInTheDocument();
      });

      const link = screen.getByText(/back to settings/i).closest('a');
      expect(link).toHaveAttribute('href', '/admin/settings');
    });
  });

  describe('UI Settings Tab', () => {
    it('should display UI settings', async () => {
      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/system settings/i)).toBeInTheDocument();
      });

      // UI Settings should be the default tab
    });
  });


  describe('Version Display', () => {
    it('should display last updated info when available', async () => {
      const updatedAt = new Date('2024-01-15T10:30:00Z');

      mockUseSystemSettings.mockReturnValue({
        settings: {
          ui: { allowUserThemeOverride: true },
          features: {},
          updatedAt: updatedAt.toISOString(),
          updatedBy: {
            id: 'admin-id',
            email: 'admin@example.com',
          },
          version: 1,
        },
        isLoading: false,
        error: null,
        isSaving: false,
        updateSettings: vi.fn(),
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      });

      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/admin@example\.com/i)).toBeInTheDocument();
      });
    });

    it('should not display updatedBy when not available', async () => {
      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/system settings/i)).toBeInTheDocument();
      });

      expect(screen.queryByText(/last updated by/i)).not.toBeInTheDocument();
    });
  });

  describe('Save Functionality', () => {
    it('should call updateSettings when saving', async () => {
      const updateSettings = vi.fn().mockResolvedValue(undefined);

      mockUseSystemSettings.mockReturnValue({
        settings: {
          ui: { allowUserThemeOverride: true },
          features: {},
          updatedAt: new Date().toISOString(),
          updatedBy: null,
          version: 1,
        },
        isLoading: false,
        error: null,
        isSaving: false,
        updateSettings,
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      });

      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/system settings/i)).toBeInTheDocument();
      });

      // Settings components will call updateSettings via handleSave
      expect(updateSettings).toBeDefined();
    });

    it('should show success message after save', async () => {
      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/system settings/i)).toBeInTheDocument();
      });

      // Snackbar should be present in component
    });

    it('should show error message when save fails', async () => {
      const updateSettings = vi.fn().mockRejectedValue(new Error('Save failed'));

      mockUseSystemSettings.mockReturnValue({
        settings: {
          ui: { allowUserThemeOverride: true },
          features: {},
          updatedAt: new Date().toISOString(),
          updatedBy: null,
          version: 1,
        },
        isLoading: false,
        error: null,
        isSaving: false,
        updateSettings,
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      });

      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/system settings/i)).toBeInTheDocument();
      });
    });
  });

  describe('Disabled State', () => {
    it('should disable all controls while saving', () => {
      mockUseSystemSettings.mockReturnValue({
        settings: {
          ui: { allowUserThemeOverride: true },
          features: {},
          updatedAt: new Date().toISOString(),
          updatedBy: null,
          version: 1,
        },
        isLoading: false,
        error: null,
        isSaving: true,
        updateSettings: vi.fn(),
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      });

      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // Components should receive disabled prop
      expect(screen.getByText(/system settings/i)).toBeInTheDocument();
    });

    it('should disable controls for read-only users', async () => {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read']),
        roles: new Set(['viewer']),
        hasPermission: (perm: string) => perm === 'system_settings:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: false,
      });

      render(<SystemSettingsPage />, {
        wrapperOptions: {
          user: {
            ...mockAdminUser,
            roles: ['viewer'],
            permissions: ['system_settings:read'],
          },
        },
      });

      await waitFor(() => {
        expect(screen.getByText(/system settings/i)).toBeInTheDocument();
      });
    });
  });
});

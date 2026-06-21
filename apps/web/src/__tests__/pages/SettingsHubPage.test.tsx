/**
 * Unit tests for SettingsHubPage.
 *
 * Mocking strategy:
 *   - usePermissions is module-mocked to control admin/permission state.
 *   - react-router-dom useNavigate is mocked to track navigation calls.
 *
 * The page renders a grid of cards grouped by section. Visibility of each card
 * depends on hasPermission(card.permission). The page redirects non-admins to /.
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

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import SettingsHubPage from '../../pages/Admin/SettingsHubPage';
import { usePermissions } from '../../hooks/usePermissions';

const mockUsePermissions = vi.mocked(usePermissions);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminPermissionsMock(permissions: string[] = []) {
  return {
    isAdmin: true,
    permissions: new Set(permissions),
    roles: new Set(['admin']),
    hasPermission: vi.fn((perm: string) => permissions.includes(perm)),
    hasAnyPermission: vi.fn().mockReturnValue(true),
    hasAllPermissions: vi.fn().mockReturnValue(true),
    hasRole: vi.fn().mockReturnValue(true),
    hasAnyRole: vi.fn().mockReturnValue(true),
  };
}

function nonAdminPermissionsMock() {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsHubPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  describe('access control', () => {
    it('redirects non-admin users to /', () => {
      mockUsePermissions.mockReturnValue(nonAdminPermissionsMock() as any);

      render(<SettingsHubPage />);

      // The Navigate component should have redirected — page content not visible
      expect(screen.queryByRole('heading', { name: /settings/i })).not.toBeInTheDocument();
    });

    it('renders the Settings heading for admins', () => {
      mockUsePermissions.mockReturnValue(
        adminPermissionsMock([
          'system_settings:read',
          'users:read',
          'ai_settings:read',
          'face_settings:read',
          'storage_settings:read',
          'jobs:read',
          'backup:read',
        ]) as any,
      );

      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('heading', { name: /^Settings$/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('section rendering', () => {
    beforeEach(() => {
      mockUsePermissions.mockReturnValue(
        adminPermissionsMock([
          'system_settings:read',
          'users:read',
          'ai_settings:read',
          'face_settings:read',
          'storage_settings:read',
          'jobs:read',
          'backup:read',
        ]) as any,
      );
    });

    it('renders all section headings', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('General')).toBeInTheDocument();
      expect(screen.getByText('AI & Enrichment')).toBeInTheDocument();
      expect(screen.getByText('Media')).toBeInTheDocument();
      expect(screen.getByText('Storage')).toBeInTheDocument();
      expect(screen.getByText('Operations')).toBeInTheDocument();
    });

    it('renders System card in General section', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('System')).toBeInTheDocument();
    });

    it('renders Users & Allowlist card when user has users:read', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Users & Allowlist')).toBeInTheDocument();
    });

    it('renders Archiving & Deletion as a "Coming soon" disabled card', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Archiving & Deletion')).toBeInTheDocument();
      expect(screen.getByText('Coming soon')).toBeInTheDocument();
    });

    it('renders AI Providers card', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('AI Providers')).toBeInTheDocument();
    });

    it('renders Face Recognition card', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Face Recognition')).toBeInTheDocument();
    });

    it('renders Bursts & Similar Pictures card', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Bursts & Similar Pictures')).toBeInTheDocument();
    });

    it('renders Geo Location card', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Geo Location')).toBeInTheDocument();
    });

    it('renders Job Queue card', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Job Queue')).toBeInTheDocument();
    });

    it('renders Backup card', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Backup')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('permission-filtered card visibility', () => {
    it('hides System card when user lacks system_settings:read', () => {
      mockUsePermissions.mockReturnValue(
        adminPermissionsMock(['users:read']) as any,
      );

      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByText('System')).not.toBeInTheDocument();
    });

    it('hides AI Providers when user lacks ai_settings:read', () => {
      mockUsePermissions.mockReturnValue(
        adminPermissionsMock(['system_settings:read', 'users:read']) as any,
      );

      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByText('AI Providers')).not.toBeInTheDocument();
    });

    it('always shows Archiving & Deletion (alwaysShow) regardless of permission', () => {
      // Even with no permissions, the alwaysShow card is rendered
      mockUsePermissions.mockReturnValue(adminPermissionsMock([]) as any);

      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Archiving & Deletion')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('navigation', () => {
    beforeEach(() => {
      mockUsePermissions.mockReturnValue(
        adminPermissionsMock([
          'system_settings:read',
          'users:read',
          'ai_settings:read',
          'face_settings:read',
          'storage_settings:read',
          'jobs:read',
          'backup:read',
        ]) as any,
      );
    });

    it('navigates to /admin/settings/ai when AI Providers card is clicked', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      // Click the card title — it is inside the CardActionArea which handles the click
      await user.click(screen.getByText('AI Providers'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/ai');
      });
    });

    it('navigates to /admin/settings/tagging when Tagging & Descriptions card is clicked', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByText('Tagging & Descriptions'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/tagging');
      });
    });

    it('navigates to /admin/settings/face when Face Recognition card is clicked', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByText('Face Recognition'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/face');
      });
    });

    it('navigates to /admin/settings/bursts when Bursts card is clicked', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByText('Bursts & Similar Pictures'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/bursts');
      });
    });

    it('navigates to /admin/settings/geo when Geo Location card is clicked', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByText('Geo Location'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/geo');
      });
    });

    it('does NOT navigate when Archiving & Deletion (disabled) card is clicked', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      // Disabled card has no CardActionArea — click the card content directly
      const archivingText = screen.getByText('Archiving & Deletion');
      await user.click(archivingText);

      // Navigate should not have been called
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });
});

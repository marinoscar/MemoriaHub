import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser, mockAdminUser } from '../../utils/test-utils';
import { QuickActions } from '../../../components/home/QuickActions';

// ---------------------------------------------------------------------------
// Mock react-router-dom — keep everything real, only stub useNavigate
// ---------------------------------------------------------------------------
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ---------------------------------------------------------------------------
// Mock usePermissions so tests control admin / permission state
// ---------------------------------------------------------------------------
vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';

const mockUsePermissions = vi.mocked(usePermissions);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function viewerPermissions() {
  mockUsePermissions.mockReturnValue({
    permissions: new Set(['user_settings:read', 'user_settings:write']),
    roles: new Set(['viewer']),
    hasPermission: (perm: string) =>
      perm === 'user_settings:read' || perm === 'user_settings:write',
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin: false,
  });
}

function adminPermissions() {
  mockUsePermissions.mockReturnValue({
    permissions: new Set([
      'user_settings:read',
      'user_settings:write',
      'system_settings:read',
      'system_settings:write',
    ]),
    roles: new Set(['admin']),
    hasPermission: (perm: string) =>
      [
        'user_settings:read',
        'user_settings:write',
        'system_settings:read',
        'system_settings:write',
      ].includes(perm),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('QuickActions', () => {
  const onUploadClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    viewerPermissions();
  });

  // -------------------------------------------------------------------------
  // Visibility — viewer user (5 non-admin actions)
  // -------------------------------------------------------------------------
  describe('Action visibility for viewer user', () => {
    it('shows "Upload" action', () => {
      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });
      expect(screen.getByText(/^upload$/i)).toBeInTheDocument();
    });

    it('shows "Browse Library" action', () => {
      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });
      expect(screen.getByText(/^browse library$/i)).toBeInTheDocument();
    });

    it('shows "Open Map" action', () => {
      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });
      expect(screen.getByText(/^open map$/i)).toBeInTheDocument();
    });

    it('shows "Manage Circles" action', () => {
      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });
      expect(screen.getByText(/^manage circles$/i)).toBeInTheDocument();
    });

    it('shows "User Settings" action', () => {
      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });
      expect(screen.getByText(/^user settings$/i)).toBeInTheDocument();
    });

    it('does NOT show "System Settings" for a viewer user', () => {
      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });
      expect(screen.queryByText(/^system settings$/i)).not.toBeInTheDocument();
    });

    it('renders exactly 5 action buttons for a viewer user', () => {
      const { container } = render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });
      const buttons = container.querySelectorAll('.MuiButton-root');
      expect(buttons.length).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // Visibility — admin user (6 actions including System Settings)
  // -------------------------------------------------------------------------
  describe('Action visibility for admin user', () => {
    beforeEach(() => {
      adminPermissions();
    });

    it('shows "System Settings" for an admin user', () => {
      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockAdminUser },
      });
      expect(screen.getByText(/^system settings$/i)).toBeInTheDocument();
    });

    it('renders all 6 action buttons for an admin user', () => {
      const { container } = render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockAdminUser },
      });
      const buttons = container.querySelectorAll('.MuiButton-root');
      expect(buttons.length).toBe(6);
    });
  });

  // -------------------------------------------------------------------------
  // Clicking "Upload" calls the onUploadClick prop
  // -------------------------------------------------------------------------
  describe('Upload action', () => {
    it('calls onUploadClick when the Upload button is clicked', async () => {
      const user = userEvent.setup();

      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });

      const uploadBtn = screen.getByRole('button', { name: /upload/i });
      await user.click(uploadBtn);

      expect(onUploadClick).toHaveBeenCalledTimes(1);
    });

    it('does NOT call navigate when Upload is clicked', async () => {
      const user = userEvent.setup();

      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });

      await user.click(screen.getByRole('button', { name: /upload/i }));

      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Navigation actions
  // -------------------------------------------------------------------------
  describe('Navigation actions', () => {
    it('navigates to /media when Browse Library is clicked', async () => {
      const user = userEvent.setup();

      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });

      await user.click(screen.getByRole('button', { name: /browse library/i }));
      expect(mockNavigate).toHaveBeenCalledWith('/media');
    });

    it('navigates to /map when Open Map is clicked', async () => {
      const user = userEvent.setup();

      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });

      await user.click(screen.getByRole('button', { name: /open map/i }));
      expect(mockNavigate).toHaveBeenCalledWith('/map');
    });

    it('navigates to /circles when Manage Circles is clicked', async () => {
      const user = userEvent.setup();

      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });

      await user.click(screen.getByRole('button', { name: /manage circles/i }));
      expect(mockNavigate).toHaveBeenCalledWith('/circles');
    });

    it('navigates to /settings when User Settings is clicked', async () => {
      const user = userEvent.setup();

      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });

      await user.click(screen.getByRole('button', { name: /user settings/i }));
      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });

    it('navigates to /admin/settings when System Settings is clicked (admin)', async () => {
      const user = userEvent.setup();
      adminPermissions();

      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await user.click(screen.getByRole('button', { name: /system settings/i }));
      expect(mockNavigate).toHaveBeenCalledWith('/admin/settings');
    });
  });

  // -------------------------------------------------------------------------
  // No "Theme" action
  // -------------------------------------------------------------------------
  describe('Removed actions', () => {
    it('does NOT render a "Theme" action button', () => {
      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });
      expect(screen.queryByText(/^theme$/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Card and section title
  // -------------------------------------------------------------------------
  describe('Section structure', () => {
    it('renders the "Quick Actions" card title', () => {
      render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });
      expect(screen.getByText(/quick actions/i)).toBeInTheDocument();
    });

    it('renders inside a MuiCard', () => {
      const { container } = render(<QuickActions onUploadClick={onUploadClick} />, {
        wrapperOptions: { user: mockUser },
      });
      expect(container.querySelector('.MuiCard-root')).toBeInTheDocument();
    });
  });
});

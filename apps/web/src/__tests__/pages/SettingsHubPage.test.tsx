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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
          'db_backup:read',
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

    it('renders Archiving & Deletion as an enabled card (not "Coming soon")', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Archiving & Deletion')).toBeInTheDocument();
      expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
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

    it('renders Job Queue Insights card when user has jobs:read', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Job Queue Insights')).toBeInTheDocument();
    });

    // The v0 "Backup" card was removed with the feature (#367). "Worker Nodes"
    // (epic #308's Local Media Backup lives behind it) and "Database Backup"
    // (#339) are different features and must stay.
    it('does not render a v0 Backup card, and leaves Worker Nodes / Database Backup intact', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByText('Backup')).not.toBeInTheDocument();
      expect(screen.getByText('Worker Nodes')).toBeInTheDocument();
      expect(screen.getByText('Database Backup')).toBeInTheDocument();
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

    it('hides Job Queue Insights when user lacks jobs:read', () => {
      mockUsePermissions.mockReturnValue(
        adminPermissionsMock(['system_settings:read', 'users:read', 'ai_settings:read']) as any,
      );

      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByText('Job Queue Insights')).not.toBeInTheDocument();
    });

    it('hides Archiving & Deletion when user lacks system_settings:read', () => {
      mockUsePermissions.mockReturnValue(adminPermissionsMock([]) as any);

      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByText('Archiving & Deletion')).not.toBeInTheDocument();
    });

    it('shows Archiving & Deletion when user has system_settings:read', () => {
      mockUsePermissions.mockReturnValue(
        adminPermissionsMock(['system_settings:read']) as any,
      );

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

    it('navigates to /admin/settings/jobs/insights when Job Queue Insights card is clicked', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByText('Job Queue Insights'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/jobs/insights');
      });
    });

    it('navigates to /admin/settings/archiving when Archiving & Deletion card is clicked', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByText('Archiving & Deletion'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/archiving');
      });
    });
  });

  // ===========================================================================
  // Search (issue #389, spec §4.4 requirement 4)
  // ===========================================================================

  describe('search', () => {
    const FULL_PERMISSIONS = [
      'system_settings:read',
      'users:read',
      'ai_settings:read',
      'face_settings:read',
      'geo_settings:read',
      'storage_settings:read',
      'jobs:read',
      'db_backup:read',
      'shares:manage_any',
    ];

    beforeEach(() => {
      mockUsePermissions.mockReturnValue(adminPermissionsMock(FULL_PERMISSIONS) as any);
    });

    it('has a "Search settings" text field', () => {
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByLabelText('Search settings')).toBeInTheDocument();
    });

    it('filters cards by title as the user types', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.type(screen.getByLabelText('Search settings'), 'job');

      expect(screen.getByText('Job Queue')).toBeInTheDocument();
      expect(screen.getByText('Job Queue Insights')).toBeInTheDocument();
      expect(screen.queryByText('AI Providers')).not.toBeInTheDocument();
      expect(screen.queryByText('System')).not.toBeInTheDocument();
    });

    it('filtering is case-insensitive', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.type(screen.getByLabelText('Search settings'), 'JOB');

      expect(screen.getByText('Job Queue')).toBeInTheDocument();
    });

    it('a group whose every card is filtered out is not rendered at all', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.type(screen.getByLabelText('Search settings'), 'job');

      // "Storage" section has no card with "job" in its title.
      expect(screen.queryByText('Storage')).not.toBeInTheDocument();
      // "Operations" (home of Job Queue) still renders.
      expect(screen.getByText('Operations')).toBeInTheDocument();
    });

    it('shows the "No settings match" message for a query that matches nothing', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.type(screen.getByLabelText('Search settings'), 'zzz-nonexistent-setting');

      expect(screen.getByText(/No settings match/)).toBeInTheDocument();
      // Not a blank page in some other sense either — no section headings.
      expect(screen.queryByText('General')).not.toBeInTheDocument();
      expect(screen.queryByText('Operations')).not.toBeInTheDocument();
    });

    it('clearing the field restores the full, unfiltered list', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      const field = screen.getByLabelText('Search settings');
      await user.type(field, 'job');
      expect(screen.queryByText('AI Providers')).not.toBeInTheDocument();

      await user.clear(field);

      expect(screen.getByText('AI Providers')).toBeInTheDocument();
      expect(screen.getByText('Job Queue')).toBeInTheDocument();
      expect(screen.getByText('General')).toBeInTheDocument();
      expect(screen.getByText('Storage')).toBeInTheDocument();
    });

    it('the clear ("x") button also restores the full list', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.type(screen.getByLabelText('Search settings'), 'job');
      await user.click(screen.getByRole('button', { name: 'Clear settings search' }));

      expect(screen.getByLabelText('Search settings')).toHaveValue('');
      expect(screen.getByText('AI Providers')).toBeInTheDocument();
    });

    it('does not match on description text, only the card title', async () => {
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      // "PostgreSQL" appears only in the Database Backup card's description.
      await user.type(screen.getByLabelText('Search settings'), 'PostgreSQL');

      expect(screen.getByText(/No settings match/)).toBeInTheDocument();
    });

    it('a permission-gated card stays hidden regardless of a matching search text (filter never bypasses authz)', async () => {
      // This admin lacks jobs:read entirely.
      mockUsePermissions.mockReturnValue(
        adminPermissionsMock(['system_settings:read', 'users:read']) as any,
      );
      const user = userEvent.setup();
      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.type(screen.getByLabelText('Search settings'), 'job');

      expect(screen.queryByText('Job Queue')).not.toBeInTheDocument();
      expect(screen.queryByText('Job Queue Insights')).not.toBeInTheDocument();
      expect(screen.getByText(/No settings match/)).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Phone drill-down vs. tablet/desktop card grid (spec §4.4)
  // ===========================================================================

  describe('responsive layout', () => {
    function setViewportWidth(px: number) {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => {
          const min = query.match(/min-width:\s*([\d.]+)px/);
          const max = query.match(/max-width:\s*([\d.]+)px/);
          let matches = true;
          if (min) matches = matches && px >= parseFloat(min[1]);
          if (max) matches = matches && px <= parseFloat(max[1]);
          return {
            matches,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
          };
        }),
      });
    }

    afterEach(() => {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });
    });

    beforeEach(() => {
      mockUsePermissions.mockReturnValue(
        adminPermissionsMock(['system_settings:read', 'users:read', 'ai_settings:read']) as any,
      );
    });

    it('renders a drill-down list on phone: titles present, descriptions absent, chevrons present', () => {
      setViewportWidth(400); // < 900 → down('md') matches → isPhone=true

      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('System')).toBeInTheDocument();
      expect(
        screen.queryByText('Configure core system settings, application behavior, and global defaults.'),
      ).not.toBeInTheDocument();

      // The row itself is a ListItemButton with a trailing chevron icon.
      const row = screen.getByText('System').closest('.MuiListItemButton-root') as HTMLElement;
      expect(row).not.toBeNull();
      expect(row.querySelector('[data-testid="ChevronRightIcon"]')).not.toBeNull();
    });

    it('renders the card grid with descriptions on tablet/desktop', () => {
      setViewportWidth(1200); // >= 900 → down('md') does not match → isPhone=false

      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('System')).toBeInTheDocument();
      expect(
        screen.getByText('Configure core system settings, application behavior, and global defaults.'),
      ).toBeInTheDocument();

      // Rendered as a card, not a drill-down list row.
      expect(screen.getByText('System').closest('.MuiCard-root')).not.toBeNull();
      expect(screen.queryByText('System')?.closest('.MuiListItemButton-root')).toBeNull();
    });

    it('drops descriptions but keeps a per-section grouping on phone', () => {
      setViewportWidth(400);

      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('General')).toBeInTheDocument();
      expect(screen.getByText('System')).toBeInTheDocument();
      expect(screen.getByText('Users & Allowlist')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Scroll restoration integration (spec §4.4 — "the single make-or-break
  // detail"). The hook itself is unit-tested directly in
  // hooks/useScrollRestoration.test.ts; this proves SettingsHubPage actually
  // wires it up under the 'admin-settings-hub' key.
  // ===========================================================================

  describe('scroll restoration', () => {
    const STORAGE_KEY = 'mh:scroll:admin-settings-hub';

    beforeEach(() => {
      mockUsePermissions.mockReturnValue(
        adminPermissionsMock(['system_settings:read', 'users:read']) as any,
      );
      window.sessionStorage.clear();
    });

    afterEach(() => {
      window.sessionStorage.clear();
      Object.defineProperty(document.documentElement, 'scrollHeight', {
        configurable: true,
        value: 0,
      });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 0 });
    });

    it('attempts to restore a saved scroll offset on mount', async () => {
      window.sessionStorage.setItem(STORAGE_KEY, '350');
      Object.defineProperty(document.documentElement, 'scrollHeight', {
        configurable: true,
        value: 2000,
      });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
      window.scrollTo = vi.fn();

      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(window.scrollTo).toHaveBeenCalledWith({ top: 350, behavior: 'auto' });
      });
    });

    it('does not attempt to scroll when nothing was saved', async () => {
      Object.defineProperty(document.documentElement, 'scrollHeight', {
        configurable: true,
        value: 2000,
      });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
      window.scrollTo = vi.fn();

      render(<SettingsHubPage />, { wrapperOptions: { user: mockAdminUser } });

      // Give any stray rAF a moment to fire, then assert nothing happened.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(window.scrollTo).not.toHaveBeenCalled();
    });
  });
});

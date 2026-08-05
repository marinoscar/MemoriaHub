/**
 * CircleDetailPage — post-#260 (the identity-and-access DataTable migration).
 *
 * Scope note, per docs/specs/datatable.md §17.8 / §18.5: table MECHANICS belong
 * to the shared component and are covered by `runDataTableConformanceSuite`;
 * none of them is re-tested here.
 *
 * What IS here is the thing issue #260 calls the single most important
 * requirement of the migration: **the per-circle permission gate did not
 * widen.** `canManage` (system admin OR `circle_admin` in this circle) still
 * decides exactly the same three things it decided before — the role editor,
 * the member/invite row actions, and the "Invite by Email" button — and it now
 * has to hold in BOTH renderers, because a card renderer that rebuilt its own
 * field list would be exactly how an editable Select or a Remove button
 * reappears for a viewer.
 *
 * Plus the second rule of this group: destructive actions confirm, and the
 * confirmation names its target.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../components/datatable/__tests__/testUtils/layoutStubs';

// ------------------------------------------------------------------
// Mock hooks and services
// ------------------------------------------------------------------

vi.mock('../../hooks/useCircleMembers', () => ({
  useCircleMembers: vi.fn(),
}));

vi.mock('../../hooks/useCircleInvites', () => ({
  useCircleInvites: vi.fn(),
}));

vi.mock('../../contexts/CircleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/CircleContext')>();
  return {
    ...actual,
    useCircleContext: vi.fn(),
    CircleProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

vi.mock('../../services/circles', () => ({
  getCircle: vi.fn(),
  updateCircle: vi.fn(),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

// Route params
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'circle-1' }),
  };
});

import CircleDetailPage from '../../pages/Circles/CircleDetailPage';
import { useCircleMembers } from '../../hooks/useCircleMembers';
import { useCircleInvites } from '../../hooks/useCircleInvites';
import { useCircleContext } from '../../contexts/CircleContext';
import { getCircle } from '../../services/circles';
import { usePermissions } from '../../hooks/usePermissions';
import { api } from '../../services/api';
import type { CircleMember, CircleInvite, CircleRole } from '../../types/circles';

const mockUseCircleMembers = vi.mocked(useCircleMembers);
const mockUseCircleInvites = vi.mocked(useCircleInvites);
const mockUseCircleContext = vi.mocked(useCircleContext);
const mockGetCircle = vi.mocked(getCircle);
const mockUsePermissions = vi.mocked(usePermissions);

// ------------------------------------------------------------------
// Factories
// ------------------------------------------------------------------

const mockCircle = {
  id: 'circle-1',
  name: 'Test Circle',
  description: null,
  ownerId: 'test-user-id',
  isPersonal: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockMember: CircleMember = {
  id: 'member-1',
  circleId: 'circle-1',
  userId: 'test-user-id',
  role: 'circle_admin',
  createdAt: new Date().toISOString(),
  user: {
    id: 'test-user-id',
    email: 'member@example.com',
    displayName: 'Test Member',
    profileImageUrl: null,
  },
};

const mockViewerMember: CircleMember = {
  id: 'member-2',
  circleId: 'circle-1',
  userId: 'viewer-user-id',
  role: 'viewer',
  createdAt: new Date().toISOString(),
  user: {
    id: 'viewer-user-id',
    email: 'viewer@example.com',
    displayName: 'Viewer Member',
    profileImageUrl: null,
  },
};

const mockInvite: CircleInvite = {
  id: 'invite-1',
  circleId: 'circle-1',
  email: 'invited@example.com',
  role: 'viewer',
  notes: null,
  addedById: 'test-user-id',
  addedAt: new Date().toISOString(),
  claimedById: null,
  claimedAt: null,
};

const mockClaimedInvite: CircleInvite = {
  ...mockInvite,
  id: 'invite-2',
  email: 'already-in@example.com',
  claimedById: 'someone',
  claimedAt: new Date().toISOString(),
};

const mockRemoveMemberById = vi.fn();
const mockChangeRole = vi.fn();
const mockCancelInvite = vi.fn();

function makeMembersDefaults(members: CircleMember[] = []) {
  return {
    members,
    loading: false,
    error: null,
    fetchMembers: vi.fn().mockResolvedValue(undefined),
    inviteMember: vi.fn().mockResolvedValue(mockMember),
    changeRole: mockChangeRole,
    removeMemberById: mockRemoveMemberById,
  };
}

function makeInvitesDefaults(invites: CircleInvite[] = []) {
  return {
    invites,
    loading: false,
    error: null,
    fetchInvites: vi.fn().mockResolvedValue(undefined),
    sendInvite: vi.fn().mockResolvedValue(mockInvite),
    cancelInvite: mockCancelInvite,
  };
}

function setCircleRole(activeCircleRole: CircleRole) {
  mockUseCircleContext.mockReturnValue({
    circles: [mockCircle],
    activeCircle: mockCircle,
    activeCircleId: 'circle-1',
    activeCircleRole,
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
  });
}

const viewerAuthUser = {
  id: 'viewer-user-id',
  email: 'viewer@example.com',
  displayName: 'Viewer',
  profileImageUrl: null,
  roles: [{ name: 'viewer' }],
  permissions: [],
  isActive: true,
  createdAt: new Date().toISOString(),
};

async function openInvitesTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /invites/i }));
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('CircleDetailPage', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    mockRemoveMemberById.mockResolvedValue(undefined);
    mockChangeRole.mockResolvedValue(undefined);
    mockCancelInvite.mockResolvedValue(undefined);
    mockGetCircle.mockResolvedValue(mockCircle);
    mockUseCircleMembers.mockReturnValue(makeMembersDefaults([mockMember]));
    mockUseCircleInvites.mockReturnValue(makeInvitesDefaults([mockInvite]));
    setCircleRole('circle_admin');
    mockUsePermissions.mockReturnValue({
      permissions: new Set<string>(),
      roles: new Set<string>(),
      hasPermission: vi.fn(),
      hasAnyPermission: vi.fn(),
      hasAllPermissions: vi.fn(),
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isAdmin: false,
    });
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  // =========================================================================
  // Rendering
  // =========================================================================

  describe('members tab', () => {
    it('renders a row per member with name, email and role', async () => {
      render(<CircleDetailPage />);

      const grid = await screen.findByRole('grid', { name: /circle members/i });
      await waitFor(() => {
        expect(within(grid).getByText('Test Member')).toBeInTheDocument();
      });
      expect(within(grid).getByText('member@example.com')).toBeInTheDocument();
    });

    it('shows the empty state when the circle has no members', async () => {
      mockUseCircleMembers.mockReturnValue(makeMembersDefaults([]));

      render(<CircleDetailPage />);

      await waitFor(() => {
        expect(screen.getByText('No members yet')).toBeInTheDocument();
      });
    });
  });

  describe('invites tab', () => {
    it('renders a row per invite with its status', async () => {
      mockUseCircleInvites.mockReturnValue(
        makeInvitesDefaults([mockInvite, mockClaimedInvite]),
      );
      const user = userEvent.setup();

      render(<CircleDetailPage />);
      await waitFor(() => expect(screen.getByRole('tab', { name: /invites/i })).toBeInTheDocument());
      await openInvitesTab(user);

      const grid = await screen.findByRole('grid', { name: /circle invites/i });
      await waitFor(() => {
        expect(within(grid).getByText('invited@example.com')).toBeInTheDocument();
      });
      expect(within(grid).getByText('already-in@example.com')).toBeInTheDocument();
      expect(within(grid).getByText('Pending')).toBeInTheDocument();
      expect(within(grid).getByText('Claimed')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // PERMISSION GATING — the requirement issue #260 calls most important
  // =========================================================================

  describe('management UI gating — circle_admin can manage', () => {
    it('gives a circle_admin an editable role Select per member', async () => {
      render(<CircleDetailPage />);

      expect(
        await screen.findByRole('combobox', { name: 'Role for Test Member' }),
      ).toBeInTheDocument();
    });

    it('gives a circle_admin the Remove control, and reports the new role on change', async () => {
      const user = userEvent.setup();
      render(<CircleDetailPage />);

      expect(
        await screen.findByRole('button', { name: 'Remove from circle for Test Member' }),
      ).toBeInTheDocument();

      await user.click(screen.getByRole('combobox', { name: 'Role for Test Member' }));
      await user.click(await screen.findByRole('option', { name: 'Viewer' }));

      await waitFor(() => {
        expect(mockChangeRole).toHaveBeenCalledWith('test-user-id', 'viewer');
      });
    });

    it('shows the invite button on the Invites tab for a circle_admin', async () => {
      const user = userEvent.setup();
      render(<CircleDetailPage />);

      await waitFor(() => expect(screen.getByRole('tab', { name: /invites/i })).toBeInTheDocument());
      await openInvitesTab(user);

      expect(screen.getByRole('button', { name: /invite by email/i })).toBeInTheDocument();
    });

    it('gives a system admin the same management UI without circle membership', async () => {
      setCircleRole('viewer');
      mockUsePermissions.mockReturnValue({
        permissions: new Set<string>(),
        roles: new Set<string>(['admin']),
        hasPermission: vi.fn(),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<CircleDetailPage />);

      // The super-admin bypass is unchanged by the migration.
      expect(
        await screen.findByRole('combobox', { name: 'Role for Test Member' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Remove from circle for Test Member' }),
      ).toBeInTheDocument();
    });
  });

  describe('management UI gating — viewer cannot manage', () => {
    beforeEach(() => {
      setCircleRole('viewer');
      mockUseCircleMembers.mockReturnValue(makeMembersDefaults([mockViewerMember]));
    });

    it('shows a viewer plain-text role, not a Select, on the grid', async () => {
      render(<CircleDetailPage />, { wrapperOptions: { user: viewerAuthUser } });

      await waitFor(() => {
        expect(screen.getByText('viewer@example.com')).toBeInTheDocument();
      });

      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(screen.getByText('Viewer')).toBeInTheDocument();
    });

    it('shows a viewer plain-text role on a phone CARD too', async () => {
      // The exact regression the requirement exists to prevent: a column's
      // `render` is reused verbatim by the card renderer, so gating it once
      // gates it everywhere. A card that rebuilt its own fields would put an
      // editable Select back in a viewer's hands.
      setInitialContainerWidth(360);

      render(<CircleDetailPage />, { wrapperOptions: { user: viewerAuthUser } });

      const table = await screen.findByTestId('datatable');
      expect(table).toHaveAttribute('data-layout', 'mobile');
      await waitFor(() => {
        expect(screen.getByText('viewer@example.com')).toBeInTheDocument();
      });

      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('gives a viewer no Remove control in EITHER renderer', async () => {
      const { unmount } = render(<CircleDetailPage />, {
        wrapperOptions: { user: viewerAuthUser },
      });

      await waitFor(() => {
        expect(screen.getByText('viewer@example.com')).toBeInTheDocument();
      });
      expect(
        screen.queryByRole('button', { name: /remove from circle/i }),
      ).not.toBeInTheDocument();
      unmount();

      setInitialContainerWidth(360);
      render(<CircleDetailPage />, { wrapperOptions: { user: viewerAuthUser } });

      await waitFor(() => {
        expect(screen.getByText('viewer@example.com')).toBeInTheDocument();
      });
      expect(
        screen.queryByRole('button', { name: /remove from circle/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /row actions/i })).not.toBeInTheDocument();
    });

    it('gives a viewer no invite button and no revoke control on the Invites tab', async () => {
      const user = userEvent.setup();
      render(<CircleDetailPage />, { wrapperOptions: { user: viewerAuthUser } });

      await waitFor(() => expect(screen.getByRole('tab', { name: /invites/i })).toBeInTheDocument());
      await openInvitesTab(user);

      expect(
        screen.queryByRole('button', { name: /invite by email/i }),
      ).not.toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByText('invited@example.com')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /revoke invite/i })).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Destructive confirmations
  // =========================================================================

  describe('Removing a member', () => {
    it('confirms, and the confirmation NAMES the member', async () => {
      const user = userEvent.setup();
      render(<CircleDetailPage />);

      await user.click(
        await screen.findByRole('button', { name: 'Remove from circle for Test Member' }),
      );

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/remove member\?/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/member@example\.com/)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
      expect(mockRemoveMemberById).not.toHaveBeenCalled();
    });

    it('removes the member once the confirmation is accepted', async () => {
      const user = userEvent.setup();
      render(<CircleDetailPage />);

      await user.click(
        await screen.findByRole('button', { name: 'Remove from circle for Test Member' }),
      );
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^remove$/i }));

      await waitFor(() => {
        expect(mockRemoveMemberById).toHaveBeenCalledWith('test-user-id');
      });
    });
  });

  describe('Revoking an invite', () => {
    it('confirms, names the invitee, and only then cancels the invite', async () => {
      const user = userEvent.setup();
      render(<CircleDetailPage />);

      await waitFor(() => expect(screen.getByRole('tab', { name: /invites/i })).toBeInTheDocument());
      await openInvitesTab(user);

      await user.click(
        await screen.findByRole('button', {
          name: 'Revoke invite for invited@example.com',
        }),
      );

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/revoke invite\?/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/invited@example\.com/)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /^revoke$/i }));

      await waitFor(() => {
        expect(mockCancelInvite).toHaveBeenCalledWith('invite-1');
      });
    });

    it('disables revoke for an already-claimed invite', async () => {
      mockUseCircleInvites.mockReturnValue(makeInvitesDefaults([mockClaimedInvite]));
      const user = userEvent.setup();

      render(<CircleDetailPage />);
      await waitFor(() => expect(screen.getByRole('tab', { name: /invites/i })).toBeInTheDocument());
      await openInvitesTab(user);

      expect(
        await screen.findByRole('button', {
          name: 'Revoke invite for already-in@example.com',
        }),
      ).toBeDisabled();
    });
  });

  // =========================================================================
  // Phone containment
  // =========================================================================

  describe('Phone layout (360px)', () => {
    it('contains its own width — nothing forces the document sideways', async () => {
      setInitialContainerWidth(360);

      render(<CircleDetailPage />);

      const table = await screen.findByTestId('datatable');
      const styles = window.getComputedStyle(table);
      expect(styles.maxWidth).toBe('100%');
      expect(styles.minWidth).toBe('0px');
    });
  });
});

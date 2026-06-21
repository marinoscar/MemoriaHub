import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';
import CircleDetailPage from '../../pages/Circles/CircleDetailPage';
import type { CircleMember, CircleInvite } from '../../types/circles';

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
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

// services/face mock not needed after the settings refactor removed per-circle
// face settings from CircleDetailPage (face recognition is now a global admin setting)

// Route params
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'circle-1' }),
  };
});

import { useCircleMembers } from '../../hooks/useCircleMembers';
import { useCircleInvites } from '../../hooks/useCircleInvites';
import { useCircleContext } from '../../contexts/CircleContext';
import { getCircle } from '../../services/circles';
import { usePermissions } from '../../hooks/usePermissions';

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
  name: "Test Circle",
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

function makeMembersDefaults(members: CircleMember[] = []) {
  return {
    members,
    loading: false,
    error: null,
    fetchMembers: vi.fn().mockResolvedValue(undefined),
    inviteMember: vi.fn().mockResolvedValue(mockMember),
    changeRole: vi.fn().mockResolvedValue(undefined),
    removeMemberById: vi.fn().mockResolvedValue(undefined),
  };
}

function makeInvitesDefaults(invites: CircleInvite[] = []) {
  return {
    invites,
    loading: false,
    error: null,
    fetchInvites: vi.fn().mockResolvedValue(undefined),
    sendInvite: vi.fn().mockResolvedValue(mockInvite),
    cancelInvite: vi.fn().mockResolvedValue(undefined),
  };
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('CircleDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCircle.mockResolvedValue(mockCircle);
    mockUseCircleMembers.mockReturnValue(makeMembersDefaults([mockMember]));
    mockUseCircleInvites.mockReturnValue(makeInvitesDefaults([mockInvite]));
    mockUseCircleContext.mockReturnValue({
      circles: [mockCircle],
      activeCircle: mockCircle,
      activeCircleId: 'circle-1',
      activeCircleRole: 'circle_admin',
      loading: false,
      setActiveCircle: vi.fn().mockResolvedValue(undefined),
      refreshCircles: vi.fn().mockResolvedValue(undefined),
    });
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
  });

  describe('members tab', () => {
    it('renders member list', async () => {
      render(<CircleDetailPage />);

      await waitFor(() => {
        expect(screen.getByText('member@example.com')).toBeInTheDocument();
      });
    });

    it('shows member display name', async () => {
      render(<CircleDetailPage />);

      await waitFor(() => {
        expect(screen.getByText('Test Member')).toBeInTheDocument();
      });
    });
  });

  describe('management UI gating — circle_admin can manage', () => {
    it('shows role select for circle_admin', async () => {
      render(<CircleDetailPage />);

      await waitFor(() => {
        // The role Select combobox should be present for admins
        const comboboxes = screen.getAllByRole('combobox');
        expect(comboboxes.length).toBeGreaterThan(0);
      });
    });

    it('shows invite button on Invites tab for circle_admin', async () => {
      const user = userEvent.setup();
      render(<CircleDetailPage />);

      await waitFor(() => {
        expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
      });

      // Switch to Invites tab
      const invitesTab = screen.getByRole('tab', { name: /invites/i });
      await user.click(invitesTab);

      expect(screen.getByRole('button', { name: /invite by email/i })).toBeInTheDocument();
    });
  });

  describe('management UI gating — viewer cannot manage', () => {
    beforeEach(() => {
      mockUseCircleContext.mockReturnValue({
        circles: [mockCircle],
        activeCircle: mockCircle,
        activeCircleId: 'circle-1',
        activeCircleRole: 'viewer',
        loading: false,
        setActiveCircle: vi.fn().mockResolvedValue(undefined),
        refreshCircles: vi.fn().mockResolvedValue(undefined),
      });
      // Viewer member (non-owner)
      mockUseCircleMembers.mockReturnValue(makeMembersDefaults([mockViewerMember]));
    });

    it('shows plain text role for viewer (not a Select)', async () => {
      render(<CircleDetailPage />, { wrapperOptions: { user: { id: 'viewer-user-id', email: 'viewer@example.com', displayName: 'Viewer', profileImageUrl: null, roles: [{ name: 'viewer' }], permissions: [], isActive: true, createdAt: new Date().toISOString() } } });

      await waitFor(() => {
        expect(screen.getByText('viewer@example.com')).toBeInTheDocument();
      });

      // No combobox (role Select) should be present for viewers
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('does not show invite button for viewer on Invites tab', async () => {
      const user = userEvent.setup();
      render(<CircleDetailPage />, { wrapperOptions: { user: { id: 'viewer-user-id', email: 'viewer@example.com', displayName: 'Viewer', profileImageUrl: null, roles: [{ name: 'viewer' }], permissions: [], isActive: true, createdAt: new Date().toISOString() } } });

      await waitFor(() => {
        expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
      });

      const invitesTab = screen.getByRole('tab', { name: /invites/i });
      await user.click(invitesTab);

      expect(screen.queryByRole('button', { name: /invite by email/i })).not.toBeInTheDocument();
    });
  });

});
// Note: the "settings tab — face recognition" describe block was removed in the
// settings refactor. Face recognition is now a global admin feature (controlled
// from /admin/settings → FaceSettingsPage), not a per-circle toggle on this page.

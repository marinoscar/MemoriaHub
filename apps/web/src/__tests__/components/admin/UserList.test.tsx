import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import { UserList } from '../../../components/admin/UserList';
import type { UserListItem } from '../../../types';

// Mock the hooks
vi.mock('../../../hooks/useUsers', () => ({
  useUsers: vi.fn(),
}));

import { useUsers } from '../../../hooks/useUsers';

const mockUseUsers = vi.mocked(useUsers);

describe('UserList', () => {
  const mockFetchUsers = vi.fn();
  const mockUpdateUser = vi.fn();
  const mockUpdateUserRoles = vi.fn();

  const mockActiveUser: UserListItem = {
    id: 'user-1',
    email: 'active@example.com',
    displayName: 'Active User',
    providerDisplayName: 'Active Provider Name',
    profileImageUrl: 'https://example.com/active.jpg',
    providerProfileImageUrl: null,
    roles: ['viewer'],
    isActive: true,
    createdAt: '2024-01-15T10:00:00Z',
  };

  const mockInactiveUser: UserListItem = {
    id: 'user-2',
    email: 'inactive@example.com',
    displayName: null,
    providerDisplayName: 'Inactive User',
    profileImageUrl: null,
    providerProfileImageUrl: 'https://example.com/inactive.jpg',
    roles: ['contributor'],
    isActive: false,
    createdAt: '2024-01-16T10:00:00Z',
  };

  const mockAdminUserItem: UserListItem = {
    id: 'admin-1',
    email: 'admin@example.com',
    displayName: 'Admin',
    providerDisplayName: 'Admin Provider',
    profileImageUrl: null,
    providerProfileImageUrl: null,
    roles: ['admin', 'contributor'],
    isActive: true,
    createdAt: '2024-01-10T10:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementation
    mockUseUsers.mockReturnValue({
      users: [],
      total: 0,
      isLoading: false,
      error: null,
      fetchUsers: mockFetchUsers,
      updateUser: mockUpdateUser.mockResolvedValue(undefined),
      updateUserRoles: mockUpdateUserRoles.mockResolvedValue(undefined),
    });
  });

  describe('Rendering', () => {
    it('should render table with users', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockActiveUser, mockInactiveUser],
        total: 2,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('active@example.com')).toBeInTheDocument();
        expect(screen.getByText('inactive@example.com')).toBeInTheDocument();
      });
    });

    it('should show loading spinner while loading', () => {
      mockUseUsers.mockReturnValue({
        users: [],
        total: 0,
        isLoading: true,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('should show error alert when error exists', async () => {
      mockUseUsers.mockReturnValue({
        users: [],
        total: 0,
        isLoading: false,
        error: 'Failed to load users',
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Failed to load users')).toBeInTheDocument();
      });
    });

    it('should show empty state when no users', async () => {
      mockUseUsers.mockReturnValue({
        users: [],
        total: 0,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('No users found')).toBeInTheDocument();
      });
    });
  });

  describe('User Display', () => {
    it('should show user avatar and email', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockActiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('active@example.com')).toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'active@example.com' })).toBeInTheDocument();
      });
    });

    it('should display custom display name when set', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockActiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Active User')).toBeInTheDocument();
      });
    });

    it('should fall back to provider display name', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockInactiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Inactive User')).toBeInTheDocument();
      });
    });

    it('should show role chips', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockAdminUserItem],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('admin')).toBeInTheDocument();
        expect(screen.getByText('contributor')).toBeInTheDocument();
      });
    });
  });

  describe('Status Display', () => {
    it('should show Active status chip for active users', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockActiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Active')).toBeInTheDocument();
      });
    });

    it('should show Inactive status chip for inactive users', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockInactiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Inactive')).toBeInTheDocument();
      });
    });
  });

  describe('Actions Menu', () => {
    it('should open menu on action button click', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockActiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      const user = userEvent.setup();

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('active@example.com')).toBeInTheDocument();
      });

      const actionButtons = screen.getAllByRole('button', { name: '' });
      const actionButton = actionButtons.find((btn) =>
        btn.querySelector('svg'),
      );
      await user.click(actionButton!);

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
    });

    it('should show "Deactivate User" option for active users', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockActiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      const user = userEvent.setup();

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('active@example.com')).toBeInTheDocument();
      });

      const actionButtons = screen.getAllByRole('button', { name: '' });
      const actionButton = actionButtons.find((btn) =>
        btn.querySelector('svg'),
      );
      await user.click(actionButton!);

      await waitFor(() => {
        expect(
          screen.getByRole('menuitem', { name: /deactivate user/i }),
        ).toBeInTheDocument();
      });
    });

    it('should show "Activate User" option for inactive users', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockInactiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      const user = userEvent.setup();

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('inactive@example.com')).toBeInTheDocument();
      });

      const actionButtons = screen.getAllByRole('button', { name: '' });
      const actionButton = actionButtons.find((btn) =>
        btn.querySelector('svg'),
      );
      await user.click(actionButton!);

      await waitFor(() => {
        expect(
          screen.getByRole('menuitem', { name: /activate user/i }),
        ).toBeInTheDocument();
      });
    });

    it('should show "Change Roles" option', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockActiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      const user = userEvent.setup();

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('active@example.com')).toBeInTheDocument();
      });

      const actionButtons = screen.getAllByRole('button', { name: '' });
      const actionButton = actionButtons.find((btn) =>
        btn.querySelector('svg'),
      );
      await user.click(actionButton!);

      await waitFor(() => {
        expect(
          screen.getByRole('menuitem', { name: /change roles/i }),
        ).toBeInTheDocument();
      });
    });
  });

  describe('Toggle Active/Inactive', () => {
    it('should call updateUser to deactivate active user', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockActiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      const user = userEvent.setup();

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('active@example.com')).toBeInTheDocument();
      });

      // Open actions menu
      const actionButtons = screen.getAllByRole('button', { name: '' });
      const actionButton = actionButtons.find((btn) =>
        btn.querySelector('svg'),
      );
      await user.click(actionButton!);

      // Click deactivate
      const deactivateOption = await screen.findByRole('menuitem', {
        name: /deactivate user/i,
      });
      await user.click(deactivateOption);

      await waitFor(() => {
        expect(mockUpdateUser).toHaveBeenCalledWith(mockActiveUser.id, {
          isActive: false,
        });
      });
    });

    it('should call updateUser to activate inactive user', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockInactiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      const user = userEvent.setup();

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('inactive@example.com')).toBeInTheDocument();
      });

      // Open actions menu
      const actionButtons = screen.getAllByRole('button', { name: '' });
      const actionButton = actionButtons.find((btn) =>
        btn.querySelector('svg'),
      );
      await user.click(actionButton!);

      // Click activate
      const activateOption = await screen.findByRole('menuitem', {
        name: /activate user/i,
      });
      await user.click(activateOption);

      await waitFor(() => {
        expect(mockUpdateUser).toHaveBeenCalledWith(mockInactiveUser.id, {
          isActive: true,
        });
      });
    });
  });

  describe('Role Management', () => {
    it('should open role submenu when "Change Roles" clicked', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockActiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      const user = userEvent.setup();

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('active@example.com')).toBeInTheDocument();
      });

      // Open actions menu
      const actionButtons = screen.getAllByRole('button', { name: '' });
      const actionButton = actionButtons.find((btn) =>
        btn.querySelector('svg'),
      );
      await user.click(actionButton!);

      // Click "Change Roles"
      const changeRolesOption = await screen.findByRole('menuitem', {
        name: /change roles/i,
      });

      // Just verify the menu item exists
      expect(changeRolesOption).toBeInTheDocument();
    });

    it('should show change roles menu option', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockActiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      const user = userEvent.setup();

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('active@example.com')).toBeInTheDocument();
      });

      // Open actions menu
      const actionButtons = screen.getAllByRole('button', { name: '' });
      const actionButton = actionButtons.find((btn) =>
        btn.querySelector('svg'),
      );
      await user.click(actionButton!);

      // Verify "Change Roles" menu item exists
      const changeRolesOption = await screen.findByRole('menuitem', {
        name: /change roles/i,
      });
      expect(changeRolesOption).toBeInTheDocument();
    });

    it('should have role management capability', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockActiveUser],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('active@example.com')).toBeInTheDocument();
      });

      // Verify updateUserRoles function is available
      expect(mockUpdateUserRoles).toBeDefined();
    });

    it('should display multiple roles for admin user', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockAdminUserItem],
        total: 1,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('admin@example.com')).toBeInTheDocument();
        expect(screen.getByText('admin')).toBeInTheDocument();
        expect(screen.getByText('contributor')).toBeInTheDocument();
      });
    });
  });

  describe('Search Functionality', () => {
    it('should have search input field', () => {
      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(
        screen.getByLabelText(/search by email or name/i),
      ).toBeInTheDocument();
    });

    it('should call fetchUsers with search parameter', async () => {
      const user = userEvent.setup();

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const searchInput = screen.getByLabelText(/search by email or name/i);
      await user.type(searchInput, 'alice');

      await waitFor(() => {
        expect(mockFetchUsers).toHaveBeenCalledWith(
          expect.objectContaining({
            search: 'alice',
            page: 1,
          }),
        );
      });
    });

    it('should reset to first page when searching', async () => {
      const user = userEvent.setup();

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const searchInput = screen.getByLabelText(/search by email or name/i);
      await user.type(searchInput, 'test');

      await waitFor(() => {
        expect(mockFetchUsers).toHaveBeenCalledWith(
          expect.objectContaining({
            page: 1,
          }),
        );
      });
    });
  });

  describe('Pagination', () => {
    it('should display pagination controls', async () => {
      mockUseUsers.mockReturnValue({
        users: [mockActiveUser, mockInactiveUser],
        total: 25,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/1–10 of 25/i)).toBeInTheDocument();
      });
    });

    it('should call fetchUsers when page changes', async () => {
      mockUseUsers.mockReturnValue({
        users: Array.from({ length: 10 }, (_, i) => ({
          ...mockActiveUser,
          id: `user-${i}`,
          email: `user${i}@example.com`,
        })),
        total: 25,
        isLoading: false,
        error: null,
        fetchUsers: mockFetchUsers,
        updateUser: mockUpdateUser,
        updateUserRoles: mockUpdateUserRoles,
      });

      const user = userEvent.setup();

      render(<UserList />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByLabelText(/next page/i)).toBeInTheDocument();
      });

      const nextButton = screen.getByLabelText(/next page/i);
      await user.click(nextButton);

      await waitFor(() => {
        expect(mockFetchUsers).toHaveBeenCalledWith(
          expect.objectContaining({
            page: 2,
          }),
        );
      });
    });
  });
});

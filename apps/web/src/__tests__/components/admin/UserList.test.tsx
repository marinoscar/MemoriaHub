/**
 * UserList — post-#260 (the identity-and-access DataTable migration).
 *
 * Scope note, per docs/specs/datatable.md §17.8 / §18.5: TABLE MECHANICS are a
 * property of the shared component, not of this table's column declarations,
 * and are covered end to end by `runDataTableConformanceSuite` (pagination /
 * sort / selection round-trips, the "never filters rows locally" negative test,
 * loading / empty / error overlays, column visibility + density, CSV escaping,
 * the issue #243 invisible-but-tappable sweep, axe in both renderers and both
 * themes, the 360px no-horizontal-scroll guard). None of that is re-tested here.
 *
 * What IS here is everything the migration could break, plus the two things
 * issue #260 singles out for this group:
 *
 *   - **permission gating**: an under-privileged caller must see no privileged
 *     action in EITHER renderer — the grid's menu and the card's menu are built
 *     from the same array, and the test proves it for both;
 *   - **destructive confirmations that name their target**: "Deactivate user?"
 *     must say WHICH user, because on a card the action is one tap away.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser, type MockUser } from '../../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';

vi.mock('../../../hooks/useUsers', () => ({
  useUsers: vi.fn(),
}));

import { UserList } from '../../../components/admin/UserList';
import {
  normalizeUserFilters,
  toUserQuery,
  buildUserColumns,
} from '../../../components/admin/usersTable';
import { useUsers } from '../../../hooks/useUsers';
import { api } from '../../../services/api';
import type { UserListItem } from '../../../types';
import type { DataTableFilterModel } from '../../../components/datatable';

const mockUseUsers = vi.mocked(useUsers);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  updatedAt: '2024-01-15T10:00:00Z',
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
  updatedAt: '2024-01-16T10:00:00Z',
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
  updatedAt: '2024-01-10T10:00:00Z',
};

/** A caller who may LIST users and nothing more. */
const readOnlyUser: MockUser = {
  id: 'read-only-id',
  email: 'readonly@example.com',
  displayName: 'Read Only',
  profileImageUrl: null,
  roles: [{ name: 'contributor' }],
  permissions: ['users:read'],
  isActive: true,
  createdAt: new Date().toISOString(),
};

/** A caller who may deactivate users but MAY NOT assign roles. */
const userWriterOnly: MockUser = {
  ...readOnlyUser,
  id: 'writer-id',
  email: 'writer@example.com',
  permissions: ['users:read', 'users:write'],
};

const mockFetchUsers = vi.fn();
const mockUpdateUser = vi.fn();
const mockUpdateUserRoles = vi.fn();

function hookResult(overrides: Partial<ReturnType<typeof useUsers>> = {}) {
  return {
    users: [] as UserListItem[],
    total: 0,
    page: 1,
    pageSize: 10,
    totalPages: 0,
    isLoading: false,
    error: null as string | null,
    fetchUsers: mockFetchUsers,
    updateUser: mockUpdateUser,
    updateUserRoles: mockUpdateUserRoles,
    ...overrides,
  } as ReturnType<typeof useUsers>;
}

function renderList(user: MockUser = mockAdminUser) {
  return render(<UserList />, { wrapperOptions: { user } });
}

async function pickOption(
  user: ReturnType<typeof userEvent.setup>,
  selectName: string | RegExp,
  optionName: string | RegExp,
) {
  const combo = await screen.findByRole('combobox', { name: selectName });
  await user.click(combo);
  await user.click(await screen.findByRole('option', { name: optionName }));
}

async function addFilter(
  user: ReturnType<typeof userEvent.setup>,
  columnLabel: string | RegExp,
  valueLabel: string | RegExp,
) {
  await pickOption(user, 'Column', columnLabel);
  await pickOption(user, 'Value', valueLabel);
  await user.click(screen.getByTestId('datatable-filter-apply'));
}

async function openRowMenu(
  user: ReturnType<typeof userEvent.setup>,
  rowLabel: string,
) {
  await user.click(
    await screen.findByRole('button', { name: `Row actions for ${rowLabel}` }),
  );
}

// ---------------------------------------------------------------------------

describe('UserList', () => {
  beforeAll(() => {
    // jsdom performs no layout, so MUI X measures a 0x0 viewport and renders
    // zero rows without these. Same recipe every DataTable suite uses.
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400); // desktop unless a test says otherwise
    mockUpdateUser.mockResolvedValue(undefined);
    mockUpdateUserRoles.mockResolvedValue(undefined);
    mockUseUsers.mockReturnValue(hookResult());
    // The table's layout-persistence hook reads/writes `/user-settings`
    // (docs/specs/datatable.md §15).
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  // =========================================================================
  // Rendering
  // =========================================================================

  describe('Rendering', () => {
    it('renders a row per user with email, display name, roles and status', async () => {
      mockUseUsers.mockReturnValue(
        hookResult({ users: [mockActiveUser, mockInactiveUser], total: 2 }),
      );

      renderList();

      const grid = await screen.findByRole('grid', { name: /users/i });
      await waitFor(() => {
        expect(within(grid).getByText('active@example.com')).toBeInTheDocument();
      });
      expect(within(grid).getByText('inactive@example.com')).toBeInTheDocument();
      expect(within(grid).getByText('Active User')).toBeInTheDocument();
      // Falls back to the provider display name when there is no override.
      expect(within(grid).getByText('Inactive User')).toBeInTheDocument();
      expect(within(grid).getByText('Active')).toBeInTheDocument();
      expect(within(grid).getByText('Inactive')).toBeInTheDocument();
    });

    it('renders one chip per role', async () => {
      mockUseUsers.mockReturnValue(hookResult({ users: [mockAdminUserItem], total: 1 }));

      renderList();

      await waitFor(() => {
        expect(screen.getByText('admin')).toBeInTheDocument();
      });
      expect(screen.getByText('contributor')).toBeInTheDocument();
    });

    it('renders the avatar with the email as its accessible name', async () => {
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));

      renderList();

      await waitFor(() => {
        expect(
          screen.getByRole('img', { name: 'active@example.com' }),
        ).toBeInTheDocument();
      });
    });

    it('surfaces the load error without blanking the rows beneath it', async () => {
      mockUseUsers.mockReturnValue(
        hookResult({ users: [mockActiveUser], total: 1, error: 'Failed to load users' }),
      );

      renderList();

      await waitFor(() => {
        expect(screen.getByText('Failed to load users')).toBeInTheDocument();
      });
      expect(screen.getByText('active@example.com')).toBeInTheDocument();
    });

    it('shows the empty state when there are no users', async () => {
      renderList();

      await waitFor(() => {
        expect(screen.getByText('No users found')).toBeInTheDocument();
      });
    });

    it('does not unmount the table while a refetch is in flight', async () => {
      mockUseUsers.mockReturnValue(
        hookResult({ users: [mockActiveUser], total: 1, isLoading: true }),
      );

      renderList();

      // Rows stay mounted beneath the loading overlay (§18.4).
      await waitFor(() => {
        expect(screen.getByText('active@example.com')).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Server state
  // =========================================================================

  describe('Search and pagination', () => {
    it('sends the debounced search term and resets to page 1', async () => {
      const user = userEvent.setup();
      renderList();

      await user.type(
        screen.getByRole('searchbox', { name: /search by email or name/i }),
        'alice',
      );

      await waitFor(() => {
        expect(mockFetchUsers).toHaveBeenCalledWith(
          expect.objectContaining({ search: 'alice', page: 1 }),
        );
      });
    });

    it('reports a 1-based page to the API when the next page is requested', async () => {
      mockUseUsers.mockReturnValue(
        hookResult({ users: [mockActiveUser], total: 25 }),
      );
      const user = userEvent.setup();

      renderList();

      await user.click(await screen.findByRole('button', { name: /go to next page/i }));

      await waitFor(() => {
        expect(mockFetchUsers).toHaveBeenCalledWith(
          expect.objectContaining({ page: 2 }),
        );
      });
    });
  });

  // =========================================================================
  // Filters
  // =========================================================================

  describe('Filter → query mapping (pure)', () => {
    const filter = (columnId: string, value: unknown): DataTableFilterModel => [
      { columnId, operator: 'is', value: value as never },
    ];

    it('maps the Status filter onto the isActive boolean', () => {
      expect(toUserQuery(filter('isActive', 'true'))).toEqual({ isActive: true });
      expect(toUserQuery(filter('isActive', 'false'))).toEqual({ isActive: false });
    });

    it('maps the Roles filter onto `role`', () => {
      expect(toUserQuery(filter('roles', 'admin'))).toEqual({ role: 'admin' });
    });

    it('ignores operators, columns and enum values this endpoint cannot express', () => {
      expect(
        toUserQuery([
          { columnId: 'isActive', operator: 'isNot', value: 'true' },
          { columnId: 'roles', operator: 'is', value: 'sysop' },
          { columnId: 'email', operator: 'is', value: 'a@b.c' },
        ]),
      ).toEqual({});
    });

    it('keeps only the last filter per column — every param is single-valued', () => {
      const model: DataTableFilterModel = [
        { columnId: 'roles', operator: 'is', value: 'admin' },
        { columnId: 'roles', operator: 'is', value: 'viewer' },
      ];
      expect(normalizeUserFilters(model)).toEqual([
        { columnId: 'roles', operator: 'is', value: 'viewer' },
      ]);
    });

    it('leaves an already-legal model alone, by reference', () => {
      const model: DataTableFilterModel = [
        { columnId: 'roles', operator: 'is', value: 'admin' },
        { columnId: 'isActive', operator: 'is', value: 'true' },
      ];
      expect(normalizeUserFilters(model)).toBe(model);
    });
  });

  describe('Filter bar', () => {
    it('refetches with isActive=false when the Inactive status filter is applied', async () => {
      const user = userEvent.setup();
      renderList();

      await addFilter(user, 'Status', 'Inactive');

      await waitFor(() => {
        expect(mockFetchUsers).toHaveBeenCalledWith(
          expect.objectContaining({ isActive: false, page: 1 }),
        );
      });
    });

    it('refetches with role= when a Roles filter is applied', async () => {
      const user = userEvent.setup();
      renderList();

      await addFilter(user, 'Roles', 'admin');

      await waitFor(() => {
        expect(mockFetchUsers).toHaveBeenCalledWith(
          expect.objectContaining({ role: 'admin', page: 1 }),
        );
      });
    });

    it('offers only `is` — the endpoint takes a single role and a single isActive', async () => {
      const user = userEvent.setup();
      renderList();

      await pickOption(user, 'Column', 'Roles');
      await user.click(await screen.findByRole('combobox', { name: 'Operator' }));

      const options = await screen.findAllByRole('option');
      expect(options.map((option) => option.textContent)).toEqual(['is']);
    });
  });

  // =========================================================================
  // PERMISSION GATING — the requirement issue #260 calls the most important
  // =========================================================================

  describe('Permission gating', () => {
    it('gives a users:read-only caller NO row actions in the grid', async () => {
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));

      renderList(readOnlyUser);

      await waitFor(() => {
        expect(screen.getByText('active@example.com')).toBeInTheDocument();
      });

      expect(
        screen.queryByRole('button', { name: /row actions/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    });

    it('gives a users:read-only caller NO row actions on a phone card either', async () => {
      // The exact regression this requirement exists to prevent: a control that
      // was merely off-screen on the grid must not reappear in the card menu.
      setInitialContainerWidth(360);
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));

      renderList(readOnlyUser);

      const table = await screen.findByTestId('datatable');
      expect(table).toHaveAttribute('data-layout', 'mobile');
      await waitFor(() => {
        expect(screen.getByText('active@example.com')).toBeInTheDocument();
      });

      expect(
        screen.queryByRole('button', { name: /row actions/i }),
      ).not.toBeInTheDocument();
    });

    it('hides "Change roles" from a caller without rbac:manage, in both renderers', async () => {
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));
      const user = userEvent.setup();

      const { unmount } = renderList(userWriterOnly);
      await openRowMenu(user, 'active@example.com');
      expect(
        await screen.findByRole('menuitem', { name: 'Deactivate' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('menuitem', { name: 'Change roles' }),
      ).not.toBeInTheDocument();
      unmount();

      setInitialContainerWidth(360);
      renderList(userWriterOnly);
      await openRowMenu(user, 'active@example.com');
      expect(
        await screen.findByRole('menuitem', { name: 'Deactivate' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('menuitem', { name: 'Change roles' }),
      ).not.toBeInTheDocument();
    });

    it('gives a fully-privileged admin all three actions', async () => {
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));
      const user = userEvent.setup();

      renderList();
      await openRowMenu(user, 'active@example.com');

      expect(await screen.findByRole('menuitem', { name: 'Activate' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Deactivate' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Change roles' })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Destructive confirmation
  // =========================================================================

  describe('Activation', () => {
    it('disables Activate for an already-active user and Deactivate for an inactive one', async () => {
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));
      const user = userEvent.setup();

      const { unmount } = renderList();
      await openRowMenu(user, 'active@example.com');
      expect(await screen.findByRole('menuitem', { name: 'Activate' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(screen.getByRole('menuitem', { name: 'Deactivate' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
      unmount();

      mockUseUsers.mockReturnValue(hookResult({ users: [mockInactiveUser], total: 1 }));
      renderList();
      await openRowMenu(user, 'inactive@example.com');
      expect(await screen.findByRole('menuitem', { name: 'Deactivate' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(screen.getByRole('menuitem', { name: 'Activate' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('confirms deactivation, and the confirmation NAMES the user', async () => {
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));
      const user = userEvent.setup();

      renderList();
      await openRowMenu(user, 'active@example.com');
      await user.click(await screen.findByRole('menuitem', { name: 'Deactivate' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/deactivate user\?/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/active@example\.com/)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it('deactivates only after the confirmation is accepted', async () => {
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));
      const user = userEvent.setup();

      renderList();
      await openRowMenu(user, 'active@example.com');
      await user.click(await screen.findByRole('menuitem', { name: 'Deactivate' }));

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));

      await waitFor(() => {
        expect(mockUpdateUser).toHaveBeenCalledWith('user-1', { isActive: false });
      });
    });

    it('activates without a confirmation — reinstating access is not destructive', async () => {
      mockUseUsers.mockReturnValue(hookResult({ users: [mockInactiveUser], total: 1 }));
      const user = userEvent.setup();

      renderList();
      await openRowMenu(user, 'inactive@example.com');
      await user.click(await screen.findByRole('menuitem', { name: 'Activate' }));

      await waitFor(() => {
        expect(mockUpdateUser).toHaveBeenCalledWith('user-2', { isActive: true });
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Role management
  // =========================================================================

  describe('Change roles', () => {
    it('opens a dialog naming the user, with a checkbox per assignable role', async () => {
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));
      const user = userEvent.setup();

      renderList();
      await openRowMenu(user, 'active@example.com');
      await user.click(await screen.findByRole('menuitem', { name: 'Change roles' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('active@example.com')).toBeInTheDocument();
      expect(within(dialog).getByRole('checkbox', { name: 'viewer' })).toBeChecked();
      expect(within(dialog).getByRole('checkbox', { name: 'admin' })).not.toBeChecked();
    });

    it('adds a role through updateUserRoles', async () => {
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));
      const user = userEvent.setup();

      renderList();
      await openRowMenu(user, 'active@example.com');
      await user.click(await screen.findByRole('menuitem', { name: 'Change roles' }));

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('checkbox', { name: 'admin' }));

      await waitFor(() => {
        expect(mockUpdateUserRoles).toHaveBeenCalledWith('user-1', ['viewer', 'admin']);
      });
    });

    it('refuses to remove a user\'s last role, and says so inline', async () => {
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));
      const user = userEvent.setup();

      renderList();
      await openRowMenu(user, 'active@example.com');
      await user.click(await screen.findByRole('menuitem', { name: 'Change roles' }));

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('checkbox', { name: 'viewer' }));

      expect(
        await within(dialog).findByText(/must have at least one role/i),
      ).toBeInTheDocument();
      expect(mockUpdateUserRoles).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Export
  // =========================================================================

  describe('Export', () => {
    it('exports every column — this table carries no secret material', () => {
      // The counterpart of the PAT table's `exportable: false` rule: nothing
      // here is token material, so nothing is excluded, and that is a
      // deliberate statement rather than an omission.
      const columns = buildUserColumns();
      expect(columns.every((column) => column.exportable !== false)).toBe(true);
    });
  });

  // =========================================================================
  // Phone
  // =========================================================================

  describe('Phone layout (360px)', () => {
    it('renders cards and keeps every action reachable', async () => {
      setInitialContainerWidth(360);
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));
      const user = userEvent.setup();

      renderList();

      const table = await screen.findByTestId('datatable');
      expect(table).toHaveAttribute('data-layout', 'mobile');

      await openRowMenu(user, 'active@example.com');
      expect(await screen.findByRole('menuitem', { name: 'Activate' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Deactivate' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Change roles' })).toBeInTheDocument();
    });

    it('still confirms — and still names the user — from a card', async () => {
      setInitialContainerWidth(360);
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));
      const user = userEvent.setup();

      renderList();
      await openRowMenu(user, 'active@example.com');
      await user.click(await screen.findByRole('menuitem', { name: 'Deactivate' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/active@example\.com/)).toBeInTheDocument();
    });

    it('contains its own width — nothing forces the document sideways', async () => {
      setInitialContainerWidth(360);
      mockUseUsers.mockReturnValue(hookResult({ users: [mockActiveUser], total: 1 }));

      renderList();

      const table = await screen.findByTestId('datatable');
      const styles = window.getComputedStyle(table);
      expect(styles.maxWidth).toBe('100%');
      expect(styles.minWidth).toBe('0px');
    });
  });
});

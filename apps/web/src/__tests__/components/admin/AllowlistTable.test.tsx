/**
 * AllowlistTable — post-#260 (the identity-and-access DataTable migration).
 *
 * Scope note, per docs/specs/datatable.md §17.8 / §18.5: table MECHANICS belong
 * to the shared component and are covered by `runDataTableConformanceSuite`;
 * none of them is re-tested here.
 *
 * What IS here is what this migration could break, plus the three rules issue
 * #260 puts on this surface specifically:
 *
 *   - a **claimed** entry still cannot be removed — in EITHER renderer;
 *   - removal **confirms**, and the confirmation names the email address;
 *   - removal is **gated on `allowlist:write`** in EITHER renderer, so a
 *     read-only operator has no destructive control anywhere in the DOM.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, type MockUser } from '../../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';

vi.mock('../../../hooks/useAllowlist', () => ({
  useAllowlist: vi.fn(),
}));

import { AllowlistTable } from '../../../components/admin/AllowlistTable';
import {
  buildAllowlistColumns,
  normalizeAllowlistFilters,
  toAllowlistQuery,
} from '../../../components/admin/allowlistColumns';
import { useAllowlist } from '../../../hooks/useAllowlist';
import { api } from '../../../services/api';
import type { AllowedEmailEntry } from '../../../types';
import type { DataTableFilterModel } from '../../../components/datatable';

const mockUseAllowlist = vi.mocked(useAllowlist);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockPendingEntry: AllowedEmailEntry = {
  id: 'entry-1',
  email: 'pending@example.com',
  notes: 'Test note',
  addedAt: '2024-01-15T10:00:00Z',
  claimedAt: null,
  addedBy: { id: 'admin-id', email: 'admin@example.com' },
  claimedBy: null,
};

const mockClaimedEntry: AllowedEmailEntry = {
  id: 'entry-2',
  email: 'claimed@example.com',
  notes: null,
  addedAt: '2024-01-15T10:00:00Z',
  claimedAt: '2024-01-16T10:00:00Z',
  addedBy: { id: 'admin-id', email: 'admin@example.com' },
  claimedBy: { id: 'user-id', email: 'user@example.com' },
};

/** An operator who may manage the allowlist. */
const allowlistAdmin: MockUser = {
  id: 'allowlist-admin-id',
  email: 'allowlist-admin@example.com',
  displayName: 'Allowlist Admin',
  profileImageUrl: null,
  roles: [{ name: 'admin' }],
  permissions: ['users:read', 'allowlist:read', 'allowlist:write'],
  isActive: true,
  createdAt: new Date().toISOString(),
};

/** An operator who may only READ the allowlist. */
const allowlistReader: MockUser = {
  ...allowlistAdmin,
  id: 'allowlist-reader-id',
  email: 'allowlist-reader@example.com',
  roles: [{ name: 'contributor' }],
  permissions: ['users:read', 'allowlist:read'],
};

const mockFetchAllowlist = vi.fn();
const mockAddEmail = vi.fn();
const mockRemoveEmail = vi.fn();

function hookResult(overrides: Partial<ReturnType<typeof useAllowlist>> = {}) {
  return {
    entries: [] as AllowedEmailEntry[],
    total: 0,
    page: 1,
    pageSize: 10,
    totalPages: 0,
    isLoading: false,
    error: null as string | null,
    fetchAllowlist: mockFetchAllowlist,
    addEmail: mockAddEmail,
    removeEmail: mockRemoveEmail,
    ...overrides,
  } as ReturnType<typeof useAllowlist>;
}

function renderTable(user: MockUser = allowlistAdmin) {
  return render(<AllowlistTable />, { wrapperOptions: { user } });
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

/**
 * The remove action is this table's ONLY row action, so on the grid the
 * DataTable renders it as a bare icon button named "{label} for {row}" rather
 * than an overflow menu (docs/specs/datatable.md §5.5).
 */
function removeControlName(email: string) {
  return `Remove from allowlist for ${email}`;
}

describe('AllowlistTable', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    mockAddEmail.mockResolvedValue(undefined);
    mockRemoveEmail.mockResolvedValue(undefined);
    mockUseAllowlist.mockReturnValue(hookResult());
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  // =========================================================================
  // Rendering
  // =========================================================================

  describe('Rendering', () => {
    it('renders a row per entry with its email and status', async () => {
      mockUseAllowlist.mockReturnValue(
        hookResult({ entries: [mockPendingEntry, mockClaimedEntry], total: 2 }),
      );

      renderTable();

      const grid = await screen.findByRole('grid', { name: /email allowlist/i });
      await waitFor(() => {
        expect(within(grid).getByText('pending@example.com')).toBeInTheDocument();
      });
      expect(within(grid).getByText('claimed@example.com')).toBeInTheDocument();
      expect(within(grid).getByText('Pending')).toBeInTheDocument();
      expect(within(grid).getByText('Claimed')).toBeInTheDocument();
    });

    it('renders who added the entry, falling back to "System"', async () => {
      mockUseAllowlist.mockReturnValue(
        hookResult({
          entries: [mockPendingEntry, { ...mockClaimedEntry, addedBy: null }],
          total: 2,
        }),
      );

      renderTable();

      await waitFor(() => {
        expect(screen.getByText('admin@example.com')).toBeInTheDocument();
      });
      expect(screen.getByText('System')).toBeInTheDocument();
    });

    it('surfaces the load error without blanking the rows beneath it', async () => {
      mockUseAllowlist.mockReturnValue(
        hookResult({
          entries: [mockPendingEntry],
          total: 1,
          error: 'Failed to load allowlist',
        }),
      );

      renderTable();

      await waitFor(() => {
        expect(screen.getByText('Failed to load allowlist')).toBeInTheDocument();
      });
      expect(screen.getByText('pending@example.com')).toBeInTheDocument();
    });

    it('shows the empty state, and a search-aware variant of it', async () => {
      const user = userEvent.setup();
      renderTable();

      await waitFor(() => {
        expect(screen.getByText('No emails in allowlist')).toBeInTheDocument();
      });

      await user.type(
        screen.getByRole('searchbox', { name: /search by email/i }),
        'nonexistent',
      );

      await waitFor(() => {
        expect(
          screen.getByText('No emails found matching your search'),
        ).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Server state
  // =========================================================================

  describe('Search, filters and pagination', () => {
    it('sends the debounced search term and resets to page 1', async () => {
      const user = userEvent.setup();
      renderTable();

      await user.type(
        screen.getByRole('searchbox', { name: /search by email/i }),
        'test@example.com',
      );

      await waitFor(() => {
        expect(mockFetchAllowlist).toHaveBeenCalledWith(
          expect.objectContaining({ search: 'test@example.com', page: 1 }),
        );
      });
    });

    it('reports a 1-based page to the API when the next page is requested', async () => {
      mockUseAllowlist.mockReturnValue(
        hookResult({ entries: [mockPendingEntry], total: 25 }),
      );
      const user = userEvent.setup();

      renderTable();
      await user.click(await screen.findByRole('button', { name: /go to next page/i }));

      await waitFor(() => {
        expect(mockFetchAllowlist).toHaveBeenCalledWith(
          expect.objectContaining({ page: 2 }),
        );
      });
    });

    it('refetches with status=claimed when the Claimed filter is applied', async () => {
      const user = userEvent.setup();
      renderTable();

      await pickOption(user, 'Column', 'Status');
      await pickOption(user, 'Value', 'Claimed');
      await user.click(screen.getByTestId('datatable-filter-apply'));

      await waitFor(() => {
        expect(mockFetchAllowlist).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'claimed', page: 1 }),
        );
      });
    });
  });

  describe('Filter → query mapping (pure)', () => {
    it('maps the status filter straight through', () => {
      expect(
        toAllowlistQuery([{ columnId: 'status', operator: 'is', value: 'pending' }]),
      ).toEqual({ status: 'pending' });
    });

    it('never emits status=all — the absence of the filter IS "all"', () => {
      expect(
        toAllowlistQuery([{ columnId: 'status', operator: 'is', value: 'all' }]),
      ).toEqual({});
      expect(toAllowlistQuery([])).toEqual({});
    });

    it('ignores operators and columns this endpoint cannot express', () => {
      expect(
        toAllowlistQuery([
          { columnId: 'status', operator: 'isNot', value: 'pending' },
          { columnId: 'email', operator: 'is', value: 'a@b.c' },
        ]),
      ).toEqual({});
    });

    it('keeps only the last filter per column', () => {
      const model: DataTableFilterModel = [
        { columnId: 'status', operator: 'is', value: 'pending' },
        { columnId: 'status', operator: 'is', value: 'claimed' },
      ];
      expect(normalizeAllowlistFilters(model)).toEqual([
        { columnId: 'status', operator: 'is', value: 'claimed' },
      ]);
    });
  });

  // =========================================================================
  // PERMISSION GATING
  // =========================================================================

  describe('Permission gating', () => {
    it('gives an allowlist:read-only operator no remove control on the grid', async () => {
      mockUseAllowlist.mockReturnValue(
        hookResult({ entries: [mockPendingEntry], total: 1 }),
      );

      renderTable(allowlistReader);

      await waitFor(() => {
        expect(screen.getByText('pending@example.com')).toBeInTheDocument();
      });

      expect(
        screen.queryByRole('button', { name: /remove from allowlist/i }),
      ).not.toBeInTheDocument();
      // …nor the page-level affordance that would 403.
      expect(screen.queryByRole('button', { name: /add email/i })).not.toBeInTheDocument();
    });

    it('gives an allowlist:read-only operator no remove control on a phone card either', async () => {
      setInitialContainerWidth(360);
      mockUseAllowlist.mockReturnValue(
        hookResult({ entries: [mockPendingEntry], total: 1 }),
      );

      renderTable(allowlistReader);

      const table = await screen.findByTestId('datatable');
      expect(table).toHaveAttribute('data-layout', 'mobile');
      await waitFor(() => {
        expect(screen.getByText('pending@example.com')).toBeInTheDocument();
      });

      expect(
        screen.queryByRole('button', { name: /row actions/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /remove from allowlist/i }),
      ).not.toBeInTheDocument();
    });

    it('gives an allowlist:write operator the remove control', async () => {
      mockUseAllowlist.mockReturnValue(
        hookResult({ entries: [mockPendingEntry], total: 1 }),
      );

      renderTable();

      expect(
        await screen.findByRole('button', {
          name: removeControlName('pending@example.com'),
        }),
      ).toBeEnabled();
    });
  });

  // =========================================================================
  // The claimed-entry rule
  // =========================================================================

  describe('Claimed entries cannot be removed', () => {
    it('disables the remove control for a claimed entry on the grid', async () => {
      mockUseAllowlist.mockReturnValue(
        hookResult({ entries: [mockClaimedEntry], total: 1 }),
      );

      renderTable();

      expect(
        await screen.findByRole('button', {
          name: removeControlName('claimed@example.com'),
        }),
      ).toBeDisabled();
    });

    it('disables the remove menu item for a claimed entry on a phone card', async () => {
      setInitialContainerWidth(360);
      mockUseAllowlist.mockReturnValue(
        hookResult({ entries: [mockClaimedEntry], total: 1 }),
      );
      const user = userEvent.setup();

      renderTable();

      await user.click(
        await screen.findByRole('button', {
          name: 'Row actions for claimed@example.com',
        }),
      );

      expect(
        await screen.findByRole('menuitem', { name: /remove from allowlist/i }),
      ).toHaveAttribute('aria-disabled', 'true');
    });

    it('never calls removeEmail for a claimed entry, even on a synthetic click', async () => {
      mockUseAllowlist.mockReturnValue(
        hookResult({ entries: [mockClaimedEntry], total: 1 }),
      );

      renderTable();

      const control = await screen.findByRole('button', {
        name: removeControlName('claimed@example.com'),
      });
      // `userEvent` refuses to click it at all (`pointer-events: none`), which
      // is itself the guarantee; `fireEvent` bypasses that check and proves the
      // handler is not merely visually disabled.
      fireEvent.click(control);

      expect(mockRemoveEmail).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Destructive confirmation
  // =========================================================================

  describe('Removing a pending entry', () => {
    it('confirms, and the confirmation NAMES the email address', async () => {
      mockUseAllowlist.mockReturnValue(
        hookResult({ entries: [mockPendingEntry], total: 1 }),
      );
      const user = userEvent.setup();

      renderTable();
      await user.click(
        await screen.findByRole('button', {
          name: removeControlName('pending@example.com'),
        }),
      );

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/remove from allowlist\?/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/pending@example\.com/)).toBeInTheDocument();
    });

    it('does nothing when the confirmation is cancelled', async () => {
      mockUseAllowlist.mockReturnValue(
        hookResult({ entries: [mockPendingEntry], total: 1 }),
      );
      const user = userEvent.setup();

      renderTable();
      await user.click(
        await screen.findByRole('button', {
          name: removeControlName('pending@example.com'),
        }),
      );

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

      expect(mockRemoveEmail).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('removes the entry once the confirmation is accepted', async () => {
      mockUseAllowlist.mockReturnValue(
        hookResult({ entries: [mockPendingEntry], total: 1 }),
      );
      const user = userEvent.setup();

      renderTable();
      await user.click(
        await screen.findByRole('button', {
          name: removeControlName('pending@example.com'),
        }),
      );

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^remove$/i }));

      await waitFor(() => {
        expect(mockRemoveEmail).toHaveBeenCalledWith('entry-1');
      });
    });
  });

  // =========================================================================
  // Add email
  // =========================================================================

  describe('Add email', () => {
    it('opens the add dialog', async () => {
      const user = userEvent.setup();
      renderTable();

      await user.click(screen.getByRole('button', { name: /add email/i }));

      expect(
        await screen.findByRole('dialog', { name: /add email to allowlist/i }),
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Export
  // =========================================================================

  describe('Export', () => {
    it('exports every column — an allowlist entry carries no secret material', () => {
      const columns = buildAllowlistColumns();
      expect(columns.every((column) => column.exportable !== false)).toBe(true);
    });
  });

  // =========================================================================
  // Phone
  // =========================================================================

  describe('Phone layout (360px)', () => {
    it('contains its own width — nothing forces the document sideways', async () => {
      setInitialContainerWidth(360);
      mockUseAllowlist.mockReturnValue(
        hookResult({ entries: [mockPendingEntry], total: 1 }),
      );

      renderTable();

      const table = await screen.findByTestId('datatable');
      const styles = window.getComputedStyle(table);
      expect(styles.maxWidth).toBe('100%');
      expect(styles.minWidth).toBe('0px');
    });

    it('keeps the notes column reachable behind "More details"', async () => {
      setInitialContainerWidth(360);
      mockUseAllowlist.mockReturnValue(
        hookResult({ entries: [mockPendingEntry], total: 1 }),
      );
      const user = userEvent.setup();

      renderTable();

      const toggle = await screen.findByTestId('datatable-card-detail-toggle');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(toggle);
      await waitFor(() => {
        expect(screen.getByText('Test note')).toBeInTheDocument();
      });
    });
  });
});

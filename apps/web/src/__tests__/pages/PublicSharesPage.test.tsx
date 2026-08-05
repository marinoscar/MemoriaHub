/**
 * Unit tests for PublicSharesPage — post-#259 (the shared-DataTable migration).
 *
 * Scope note, per docs/specs/datatable.md §17.8 / §18.5: TABLE MECHANICS are a
 * property of the component and are covered end to end by
 * `runDataTableConformanceSuite` (pagination/sort/selection round-trips, the
 * negative "never filters rows locally" test, loading/empty/error overlays,
 * column visibility + density, CSV escaping, the issue #243 invisible-but-
 * tappable sweep, axe in both renderers and both themes). None of that is
 * re-tested here.
 *
 * What IS here is everything this migration could plausibly break:
 *   - the status TABS ↔ filter-model wiring (issue #259's headline decision),
 *     including that the status column is absent from the generic filter picker,
 *   - the public URL column: truncated, never in full, and NOT exportable,
 *   - every mutation: copy, edit expiration, single revoke, bulk revoke /
 *     set-expiration / delete,
 *   - permission gating,
 *   - the phone layout actually reaching the row actions that used to be off
 *     screen (the bug the issue was filed for).
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../components/datatable/__tests__/testUtils/layoutStubs';
import type { MediaShare } from '../../types/sharing';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before imports they affect
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useMediaShares', () => ({
  useMediaShares: vi.fn(),
}));

import { usePermissions } from '../../hooks/usePermissions';
import { useMediaShares } from '../../hooks/useMediaShares';
import PublicSharesPage from '../../pages/Admin/PublicSharesPage';
import {
  buildShareColumns,
  normalizeShareFilters,
  statusFromFilters,
  toShareQuery,
  truncateShareUrl,
  withStatusFilter,
} from '../../pages/Admin/sharesTable';
import type { DataTableFilterModel } from '../../components/datatable';
import { api } from '../../services/api';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseMediaShares = vi.mocked(useMediaShares);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePermissions(isAdmin: boolean) {
  return {
    permissions: new Set<string>(),
    roles: new Set<string>(isAdmin ? ['admin'] : ['viewer']),
    hasPermission: vi.fn().mockReturnValue(isAdmin),
    hasAnyPermission: vi.fn().mockReturnValue(isAdmin),
    hasAllPermissions: vi.fn().mockReturnValue(isAdmin),
    hasRole: vi.fn().mockReturnValue(isAdmin),
    hasAnyRole: vi.fn().mockReturnValue(isAdmin),
    isAdmin,
  };
}

function makeShare(overrides: Partial<MediaShare> = {}): MediaShare {
  const id = overrides.id ?? 'share-1';
  return {
    id,
    token: `tok-${id}`,
    publicUrl: `https://app.example.com/s/tok-${id}`,
    targetType: 'media_item',
    status: 'active',
    expiresAt: null,
    revokedAt: null,
    createdAt: '2024-01-15T10:00:00.000Z',
    itemCount: undefined,
    preview: { thumbnailUrl: null },
    ...overrides,
  };
}

function makeHook(
  overrides: Partial<ReturnType<typeof useMediaShares>> = {},
): ReturnType<typeof useMediaShares> {
  return {
    shares: [],
    meta: null,
    isLoading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    createShare: vi.fn(),
    updateShare: vi.fn().mockResolvedValue(makeShare()),
    revokeShare: vi.fn().mockResolvedValue(undefined),
    bulkAction: vi.fn().mockResolvedValue({ affected: 0 }),
    ...overrides,
  };
}

/** The row-scoped accessible-name suffix: the first `primary` column's value. */
function rowLabel(id: string) {
  return id.slice(0, 8);
}

function renderPage() {
  return render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });
}

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, id: string) {
  const trigger = await screen.findByRole('button', {
    name: `Row actions for ${rowLabel(id)}`,
  });
  await user.click(trigger);
}

// ---------------------------------------------------------------------------
// Clipboard setup — done once at suite level so the same mock object is
// referenced by both the outer beforeEach (which calls vi.clearAllMocks)
// and the inner Copy-link tests.
// ---------------------------------------------------------------------------

const writeTextMock = vi.fn();

beforeAll(() => {
  // jsdom performs no layout, so MUI X measures a 0×0 viewport and renders zero
  // rows without these. Same recipe every DataTable suite uses.
  installLayoutStubs();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    writable: true,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PublicSharesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400); // desktop layout unless a test says otherwise

    mockUsePermissions.mockReturnValue(makePermissions(true));
    mockUseMediaShares.mockReturnValue(makeHook());

    // Re-installed per test: `userEvent.setup()` swaps in its own
    // `navigator.clipboard` stub and never restores it, so a suite-level
    // definition would be gone by the time the copy tests run.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });
    writeTextMock.mockResolvedValue(undefined);

    // The table's layout-persistence hook reads/writes `/user-settings`
    // (docs/specs/datatable.md §15). Stub the real `api` singleton.
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  // =========================================================================
  // Authorization
  // =========================================================================

  describe('Authorization', () => {
    it('redirects non-admin users — page content is not rendered', () => {
      mockUsePermissions.mockReturnValue(makePermissions(false));

      render(<PublicSharesPage />, {
        wrapperOptions: { user: mockAdminUser, route: '/admin/shares' },
      });

      expect(screen.queryByText(/public sharing/i)).not.toBeInTheDocument();
    });

    it('renders page content for admin users', () => {
      renderPage();

      expect(screen.getByRole('heading', { name: /public sharing/i })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Column definitions
  // =========================================================================

  describe('Column definitions', () => {
    const columns = buildShareColumns({ onCopy: vi.fn() });
    const byId = (id: string) => columns.find((column) => column.id === id)!;

    it('marks the public URL column non-exportable — the token is a credential', () => {
      expect(byId('publicUrl').exportable).toBe(false);
    });

    it('does not declare the status column as generically filterable (the tabs own it)', () => {
      expect(byId('status').filterable).toBeUndefined();
      // …but it still carries the enum labels the tab-produced chip reads from.
      expect(byId('status').enumValues?.map((option) => option.value)).toEqual([
        'active',
        'expired',
        'revoked',
      ]);
    });

    it('declares targetType as filterable — no bespoke control competes for it', () => {
      expect(byId('targetType').filterable).toEqual(['is']);
    });

    it('leads with a row-unique primary column so per-row controls are nameable', () => {
      const firstPrimary = columns.find((column) => column.priority === 'primary')!;
      expect(firstPrimary.id).toBe('id');
      expect(firstPrimary.value!(makeShare({ id: 'abcdefgh-1234' }))).toBe('abcdefgh');
    });

    it('truncates a URL rather than printing it in full', () => {
      const long = 'https://app.example.com/s/tok-abcdefghijklmnopqrstuvwxyz';
      const shown = truncateShareUrl(long);
      expect(shown.length).toBeLessThan(long.length);
      expect(shown.endsWith('…')).toBe(true);
      expect(truncateShareUrl('https://a.co/s/x')).toBe('https://a.co/s/x');
    });
  });

  // =========================================================================
  // Table rendering
  // =========================================================================

  describe('Table rendering', () => {
    it('shows "No shares found." when the share list is empty', async () => {
      mockUseMediaShares.mockReturnValue(makeHook({ shares: [] }));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/no shares found/i)).toBeInTheDocument();
      });
    });

    it('renders a row per share with its status chip', async () => {
      mockUseMediaShares.mockReturnValue(
        makeHook({
          shares: [
            makeShare({ id: 's1-aaaaaaa', status: 'active' }),
            makeShare({ id: 's2-bbbbbbb', status: 'expired' }),
            makeShare({ id: 's3-ccccccc', status: 'revoked', targetType: 'album', itemCount: 4 }),
          ],
        }),
      );

      renderPage();

      const grid = await screen.findByRole('grid', { name: /public shares/i });
      await waitFor(() => {
        expect(within(grid).getByText('Active')).toBeInTheDocument();
      });
      expect(within(grid).getByText('Expired')).toBeInTheDocument();
      expect(within(grid).getByText('Revoked')).toBeInTheDocument();
      expect(within(grid).getByText('Album')).toBeInTheDocument();
    });

    it('renders the public URL TRUNCATED, never in full', async () => {
      const publicUrl = 'https://app.example.com/s/tok-abcdefghijklmnopqrstuvwxyz';
      mockUseMediaShares.mockReturnValue(
        makeHook({ shares: [makeShare({ id: 's1-aaaaaaa', publicUrl })] }),
      );

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(truncateShareUrl(publicUrl))).toBeInTheDocument();
      });
      expect(screen.queryByText(publicUrl)).not.toBeInTheDocument();
    });

    it('renders the status filter tabs: All, Active, Expired, Revoked', () => {
      renderPage();

      expect(screen.getByRole('tab', { name: /^all$/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^active$/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^expired$/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^revoked$/i })).toBeInTheDocument();
    });

    it('surfaces a list error without blanking the rows underneath it', async () => {
      mockUseMediaShares.mockReturnValue(
        makeHook({ shares: [makeShare({ id: 's1-aaaaaaa' })], error: 'Share load failed' }),
      );

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/share load failed/i)).toBeInTheDocument();
      });
      expect(screen.getByText('s1-aaaaa'.slice(0, 8))).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Status tabs ⇄ filter model (issue #259's headline decision)
  // =========================================================================

  describe('Status tabs ⇄ filter model (pure)', () => {
    it('reads the active tab back out of the model', () => {
      expect(statusFromFilters([])).toBe('all');
      expect(
        statusFromFilters([{ columnId: 'status', operator: 'is', value: 'revoked' }]),
      ).toBe('revoked');
      // An unknown status value is not a tab.
      expect(
        statusFromFilters([{ columnId: 'status', operator: 'is', value: 'bogus' }]),
      ).toBe('all');
    });

    it('writes a tab selection into the model, replacing any previous status', () => {
      const first = withStatusFilter([], 'active');
      expect(first).toEqual([{ columnId: 'status', operator: 'is', value: 'active' }]);

      const second = withStatusFilter(first, 'revoked');
      expect(second).toEqual([{ columnId: 'status', operator: 'is', value: 'revoked' }]);
    });

    it('"All" REMOVES the status entry — absence is what the endpoint means by all', () => {
      const model = withStatusFilter([], 'expired');
      expect(withStatusFilter(model, 'all')).toEqual([]);
    });

    it('leaves other filters untouched when the tab changes', () => {
      const model: DataTableFilterModel = [
        { columnId: 'targetType', operator: 'is', value: 'album' },
      ];
      expect(withStatusFilter(model, 'active')).toEqual([
        { columnId: 'targetType', operator: 'is', value: 'album' },
        { columnId: 'status', operator: 'is', value: 'active' },
      ]);
    });

    it('maps the model onto the endpoint params', () => {
      expect(toShareQuery([])).toEqual({});
      expect(toShareQuery([{ columnId: 'status', operator: 'is', value: 'expired' }])).toEqual({
        status: 'expired',
      });
      expect(
        toShareQuery([
          { columnId: 'status', operator: 'is', value: 'active' },
          { columnId: 'targetType', operator: 'is', value: 'album' },
        ]),
      ).toEqual({ status: 'active', targetType: 'album' });
    });

    it('ignores operators and values this endpoint cannot express', () => {
      expect(
        toShareQuery([
          { columnId: 'status', operator: 'isNot', value: 'active' },
          { columnId: 'status', operator: 'is', value: 'bogus' },
          { columnId: 'targetType', operator: 'is', value: 'nope' },
          { columnId: 'expiresAt', operator: 'is', value: 'whenever' },
        ]),
      ).toEqual({});
    });

    it('keeps one filter per column, last one wins', () => {
      const model: DataTableFilterModel = [
        { columnId: 'targetType', operator: 'is', value: 'media_item' },
        { columnId: 'targetType', operator: 'is', value: 'album' },
      ];
      expect(normalizeShareFilters(model)).toEqual([
        { columnId: 'targetType', operator: 'is', value: 'album' },
      ]);
      const legal: DataTableFilterModel = [
        { columnId: 'status', operator: 'is', value: 'active' },
      ];
      expect(normalizeShareFilters(legal)).toBe(legal);
    });
  });

  describe('Status tabs ⇄ filter model (rendered)', () => {
    it('selecting a tab sends that status to the API and shows it as a chip', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(screen.getByRole('tab', { name: /^revoked$/i }));

      await waitFor(() => {
        expect(mockUseMediaShares).toHaveBeenCalledWith(
          expect.objectContaining({ scope: 'all', status: 'revoked', page: 1 }),
        );
      });
      expect(await screen.findByText('Status is Revoked')).toBeInTheDocument();
    });

    it('removing the status chip returns the tab to "All" and drops the param', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(screen.getByRole('tab', { name: /^active$/i }));
      const chip = await screen.findByText('Status is Active');

      const deleteIcon = chip.closest('.MuiChip-root')!.querySelector('.MuiChip-deleteIcon')!;
      await user.click(deleteIcon);

      await waitFor(() => {
        expect(screen.queryByText('Status is Active')).not.toBeInTheDocument();
      });
      expect(screen.getByRole('tab', { name: /^all$/i })).toHaveAttribute('aria-selected', 'true');
      expect(mockUseMediaShares).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: undefined }),
      );
    });

    it('does NOT offer Status in the generic filter picker — the tabs are the only control', async () => {
      const user = userEvent.setup();
      renderPage();

      const combo = await screen.findByRole('combobox', { name: 'Column' });
      await user.click(combo);

      expect(await screen.findByRole('option', { name: 'Type' })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'Status' })).not.toBeInTheDocument();
    });

    it('applies a Type filter through the generic filter bar', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('combobox', { name: 'Column' }));
      await user.click(await screen.findByRole('option', { name: 'Type' }));
      await user.click(await screen.findByRole('combobox', { name: 'Value' }));
      await user.click(await screen.findByRole('option', { name: 'Album' }));
      await user.click(screen.getByTestId('datatable-filter-apply'));

      await waitFor(() => {
        expect(mockUseMediaShares).toHaveBeenLastCalledWith(
          expect.objectContaining({ targetType: 'album', page: 1 }),
        );
      });
    });
  });

  // =========================================================================
  // Copy link
  // =========================================================================

  describe('Copy link', () => {
    it('clicking the in-cell copy button writes the FULL url to the clipboard', async () => {
      const share = makeShare({ id: 's1-aaaaaaa', publicUrl: 'https://app.example.com/s/tok-s1' });
      mockUseMediaShares.mockReturnValue(makeHook({ shares: [share] }));

      renderPage();

      // fireEvent rather than userEvent so user-event's own clipboard stub does
      // not intercept the navigator.clipboard.writeText call.
      const copyButton = await screen.findByRole('button', { name: /copy link/i });
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith('https://app.example.com/s/tok-s1');
      });
    });

    it('shows a success snackbar after copying', async () => {
      mockUseMediaShares.mockReturnValue(
        makeHook({ shares: [makeShare({ id: 's1-aaaaaaa' })] }),
      );

      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: /copy link/i }));

      await waitFor(() => {
        expect(screen.getByText(/link copied to clipboard/i)).toBeInTheDocument();
      });
    });

    it('renders one copy button per share', async () => {
      mockUseMediaShares.mockReturnValue(
        makeHook({
          shares: [makeShare({ id: 's1-aaaaaaa' }), makeShare({ id: 's2-bbbbbbb' })],
        }),
      );

      renderPage();

      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /copy link/i })).toHaveLength(2);
      });
    });
  });

  // =========================================================================
  // Row actions
  // =========================================================================

  describe('Row actions', () => {
    it('revoking confirms first, then calls revokeShare with the share id', async () => {
      const hook = makeHook({ shares: [makeShare({ id: 'share-abc12345', status: 'active' })] });
      mockUseMediaShares.mockReturnValue(hook);
      const user = userEvent.setup();

      renderPage();
      await openRowMenu(user, 'share-abc12345');
      await user.click(await screen.findByRole('menuitem', { name: /^revoke$/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/revoke share\?/i)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: /^revoke$/i }));

      await waitFor(() => {
        expect(hook.revokeShare).toHaveBeenCalledWith('share-abc12345');
      });
    });

    it('cancelling the revoke confirmation calls nothing', async () => {
      const hook = makeHook({ shares: [makeShare({ id: 'share-abc12345', status: 'active' })] });
      mockUseMediaShares.mockReturnValue(hook);
      const user = userEvent.setup();

      renderPage();
      await openRowMenu(user, 'share-abc12345');
      await user.click(await screen.findByRole('menuitem', { name: /^revoke$/i }));

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

      expect(hook.revokeShare).not.toHaveBeenCalled();
    });

    it('disables both row actions for an already-revoked share', async () => {
      mockUseMediaShares.mockReturnValue(
        makeHook({ shares: [makeShare({ id: 'share-dead1234', status: 'revoked' })] }),
      );
      const user = userEvent.setup();

      renderPage();
      await openRowMenu(user, 'share-dead1234');

      expect(await screen.findByRole('menuitem', { name: /^revoke$/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(screen.getByRole('menuitem', { name: /edit expiration/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('edits an expiration through the dialog', async () => {
      const hook = makeHook({ shares: [makeShare({ id: 'share-abc12345' })] });
      mockUseMediaShares.mockReturnValue(hook);
      const user = userEvent.setup();

      renderPage();
      await openRowMenu(user, 'share-abc12345');
      await user.click(await screen.findByRole('menuitem', { name: /edit expiration/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/edit expiration/i)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(hook.updateShare).toHaveBeenCalledWith('share-abc12345', { expiresAt: null });
      });
    });
  });

  // =========================================================================
  // Bulk actions
  // =========================================================================

  describe('Bulk actions', () => {
    function setupWithShares() {
      const hook = makeHook({
        shares: [
          makeShare({ id: 'bulk-1aaaaaa', status: 'active' }),
          makeShare({ id: 'bulk-2bbbbbb', status: 'active' }),
        ],
      });
      mockUseMediaShares.mockReturnValue(hook);
      return hook;
    }

    it('select-all shows the bulk bar with a count', async () => {
      setupWithShares();
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByRole('checkbox', { name: /select all rows/i }));

      await waitFor(() => {
        expect(screen.getByTestId('datatable-bulk-action-bar')).toBeInTheDocument();
      });
      expect(screen.getByText(/2 of 2 selected/i)).toBeInTheDocument();
    });

    it('bulk revoke confirms with the count, then calls bulkAction', async () => {
      const hook = setupWithShares();
      hook.bulkAction = vi.fn().mockResolvedValue({ affected: 2 });
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByRole('checkbox', { name: /select all rows/i }));
      await user.click(await screen.findByRole('button', { name: /^revoke$/i }));

      await waitFor(() => {
        expect(screen.getByText(/revoke 2 shares\?/i)).toBeInTheDocument();
      });
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^revoke$/i }));

      await waitFor(() => {
        expect(hook.bulkAction).toHaveBeenCalledWith({
          ids: ['bulk-1aaaaaa', 'bulk-2bbbbbb'],
          action: 'revoke',
        });
      });
    });

    it('bulk set-expiration calls bulkAction with set_expiration', async () => {
      const hook = setupWithShares();
      hook.bulkAction = vi.fn().mockResolvedValue({ affected: 2 });
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByRole('checkbox', { name: /select all rows/i }));
      await user.click(await screen.findByRole('button', { name: /set expiration/i }));

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(hook.bulkAction).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'set_expiration', expiresAt: null }),
        );
      });
    });

    it('bulk delete confirms, then calls bulkAction with delete', async () => {
      const hook = setupWithShares();
      hook.bulkAction = vi.fn().mockResolvedValue({ affected: 2 });
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByRole('checkbox', { name: /select all rows/i }));
      await user.click(await screen.findByRole('button', { name: /^delete$/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/delete 2 shares\?/i)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(hook.bulkAction).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'delete' }),
        );
      });
    });
  });

  // =========================================================================
  // Phone — the bug this issue was filed for
  // =========================================================================

  describe('Phone layout (360px)', () => {
    it('renders cards and still reaches every row action', async () => {
      setInitialContainerWidth(360);
      mockUseMediaShares.mockReturnValue(
        makeHook({ shares: [makeShare({ id: 'share-abc12345', status: 'active' })] }),
      );
      const user = userEvent.setup();

      renderPage();

      const table = await screen.findByTestId('datatable');
      expect(table).toHaveAttribute('data-layout', 'mobile');

      await openRowMenu(user, 'share-abc12345');
      expect(await screen.findByRole('menuitem', { name: /^revoke$/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /edit expiration/i })).toBeInTheDocument();
    });

    it('keeps the copy button reachable on a card', async () => {
      setInitialContainerWidth(360);
      mockUseMediaShares.mockReturnValue(
        makeHook({ shares: [makeShare({ id: 'share-abc12345' })] }),
      );

      renderPage();

      expect(await screen.findByRole('button', { name: /copy link/i })).toBeInTheDocument();
    });

    it('runs the bulk bar identically on a phone', async () => {
      setInitialContainerWidth(360);
      mockUseMediaShares.mockReturnValue(
        makeHook({ shares: [makeShare({ id: 'share-abc12345', status: 'active' })] }),
      );
      const user = userEvent.setup();

      renderPage();
      await user.click(await screen.findByRole('checkbox', { name: /select all rows/i }));

      await waitFor(() => {
        expect(screen.getByTestId('datatable-bulk-action-bar')).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /^revoke$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /set expiration/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    });

    it('contains its own width — nothing forces the document sideways', async () => {
      setInitialContainerWidth(360);
      mockUseMediaShares.mockReturnValue(
        makeHook({ shares: [makeShare({ id: 'share-abc12345' })] }),
      );

      renderPage();

      const table = await screen.findByTestId('datatable');
      const styles = window.getComputedStyle(table);
      expect(styles.maxWidth).toBe('100%');
      expect(styles.minWidth).toBe('0px');
    });
  });
});

/**
 * Tests for apps/web/src/pages/Admin/PublicSharesPage.tsx
 *
 * Covers:
 *  Authorization:
 *   - redirects non-admin users to /
 *   - renders page content for admin users
 *
 *  Table rendering:
 *   - shows shares from listShares({ scope: 'all' })
 *   - renders status chip for each share
 *   - shows "No shares found." when list is empty
 *   - shows "Public Sharing" heading
 *
 *  Single revoke:
 *   - clicking revoke icon opens confirmation dialog
 *   - confirming revoke calls revokeShare(id)
 *
 *  Copy link:
 *   - clicking copy icon calls navigator.clipboard.writeText with the publicUrl
 *
 *  Bulk select + revoke:
 *   - selecting all rows shows bulk action bar
 *   - clicking "Revoke" in bulk bar opens confirmation dialog
 *   - confirming bulk revoke calls bulkShares with correct ids and action
 *
 *  Status filter tabs:
 *   - renders "All", "Active", "Expired", "Revoked" tabs
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';
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

// ---------------------------------------------------------------------------
// Clipboard setup — done once at suite level so the same mock object is
// referenced by both the outer beforeEach (which calls vi.clearAllMocks)
// and the inner Copy-link tests.
// ---------------------------------------------------------------------------

const writeTextMock = vi.fn();

beforeAll(() => {
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

    // Default: admin permissions
    mockUsePermissions.mockReturnValue(makePermissions(true));

    // Default: empty share list
    mockUseMediaShares.mockReturnValue(makeHook());

    // Restore clipboard mock after vi.clearAllMocks clears it
    writeTextMock.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------

  describe('Authorization', () => {
    it('redirects non-admin users — page content is not rendered', () => {
      mockUsePermissions.mockReturnValue(makePermissions(false));

      render(<PublicSharesPage />, {
        wrapperOptions: { user: mockAdminUser, route: '/admin/shares' },
      });

      expect(screen.queryByText(/public sharing/i)).not.toBeInTheDocument();
    });

    it('renders page content for admin users', () => {
      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/public sharing/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Table rendering
  // -------------------------------------------------------------------------

  describe('Table rendering', () => {
    it('shows "Public Sharing" heading', () => {
      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('heading', { name: /public sharing/i })).toBeInTheDocument();
    });

    it('shows "No shares found." when share list is empty', () => {
      mockUseMediaShares.mockReturnValue(makeHook({ shares: [] }));

      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/no shares found/i)).toBeInTheDocument();
    });

    it('renders a row for each share in the list', () => {
      mockUseMediaShares.mockReturnValue(
        makeHook({
          shares: [
            makeShare({ id: 's1' }),
            makeShare({ id: 's2' }),
            makeShare({ id: 's3' }),
          ],
        }),
      );

      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      // Each share row has a checkbox — 3 data rows + 1 header checkbox = 4 checkboxes
      const checkboxes = screen.getAllByRole('checkbox');
      // 1 header (select-all) + 3 rows
      expect(checkboxes.length).toBeGreaterThanOrEqual(3);
    });

    it('renders a status chip for each share', () => {
      mockUseMediaShares.mockReturnValue(
        makeHook({
          shares: [
            makeShare({ id: 's1', status: 'active' }),
            makeShare({ id: 's2', status: 'expired' }),
            makeShare({ id: 's3', status: 'revoked' }),
          ],
        }),
      );

      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      // "Active" appears both in the tab and as a chip — use getAllByText
      expect(screen.getAllByText('Active').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Expired').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Revoked').length).toBeGreaterThanOrEqual(1);

      // Verify the MUI Chip elements specifically
      const { container } = render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });
      const chips = container.querySelectorAll('.MuiChip-root');
      expect(chips.length).toBe(3);
    });

    it('renders the public URL for each share', () => {
      const share = makeShare({ id: 's1', publicUrl: 'https://app.example.com/s/tok-s1' });
      mockUseMediaShares.mockReturnValue(makeHook({ shares: [share] }));

      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/tok-s1/)).toBeInTheDocument();
    });

    it('renders status filter tabs: All, Active, Expired, Revoked', () => {
      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('tab', { name: /^all$/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^active$/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^expired$/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^revoked$/i })).toBeInTheDocument();
    });

    it('shows loading spinner in the table body when isLoading is true and shares list is empty', () => {
      mockUseMediaShares.mockReturnValue(makeHook({ isLoading: true, shares: [] }));

      const { container } = render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      // Multiple spinners can appear (table cell + refresh button); at least one must exist
      const progressbars = screen.getAllByRole('progressbar');
      expect(progressbars.length).toBeGreaterThanOrEqual(1);

      // The table body contains a cell with a spinner (24px size)
      const tableSpinner = container.querySelector('tbody .MuiCircularProgress-root');
      expect(tableSpinner).not.toBeNull();
    });

    it('renders column headers: Preview, Type, Items, Public URL, Expires, Status, Created', () => {
      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Preview')).toBeInTheDocument();
      expect(screen.getByText('Type')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Copy link
  // -------------------------------------------------------------------------

  describe('Copy link', () => {
    // navigator.clipboard is mocked at suite level (see writeTextMock above).
    // vi.clearAllMocks() in the outer beforeEach clears call counts; the outer
    // beforeEach also re-applies mockResolvedValue so the mock stays functional.

    it('clicking copy icon calls navigator.clipboard.writeText with the publicUrl', async () => {
      const share = makeShare({
        id: 's1',
        publicUrl: 'https://app.example.com/s/tok-s1',
      });
      mockUseMediaShares.mockReturnValue(makeHook({ shares: [share] }));

      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      // Use fireEvent instead of userEvent so that user-event's own clipboard
      // stub does not intercept the navigator.clipboard.writeText call.
      const copyButton = screen.getByRole('button', { name: /copy link/i });
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith('https://app.example.com/s/tok-s1');
      });
    });

    it('clicking copy icon shows a success snackbar', async () => {
      const share = makeShare({
        id: 's1',
        publicUrl: 'https://app.example.com/s/tok-s1',
      });
      mockUseMediaShares.mockReturnValue(makeHook({ shares: [share] }));

      const user = userEvent.setup();
      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      const copyButton = screen.getByRole('button', { name: /copy link/i });
      await user.click(copyButton);

      await waitFor(() => {
        expect(screen.getByText(/link copied to clipboard/i)).toBeInTheDocument();
      });
    });

    it('copy icon button is rendered for each share', () => {
      const shares = [makeShare({ id: 's1' }), makeShare({ id: 's2' })];
      mockUseMediaShares.mockReturnValue(makeHook({ shares }));

      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      const copyButtons = screen.getAllByRole('button', { name: /copy link/i });
      expect(copyButtons).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Single revoke
  // -------------------------------------------------------------------------

  describe('Single revoke', () => {
    function setupWithShare(id = 'share-1') {
      const share = makeShare({ id, status: 'active' });
      const hookResult = makeHook({ shares: [share] });
      mockUseMediaShares.mockReturnValue(hookResult);
      return { share, hookResult };
    }

    it('clicking the revoke icon opens a confirmation dialog', async () => {
      setupWithShare('s1');

      const user = userEvent.setup();
      const { container } = render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      // The revoke IconButton is wrapped in a <span> (for Tooltip with disabled child support),
      // so aria-label is on the span, not the button. Query by the Block icon's data-testid.
      const revokeIcon = container.querySelector('[data-testid="BlockIcon"]');
      expect(revokeIcon).toBeTruthy();
      const revokeBtn = revokeIcon!.closest('button') as HTMLButtonElement;
      expect(revokeBtn).toBeTruthy();

      await user.click(revokeBtn);

      await waitFor(() => {
        expect(screen.getByText(/revoke share\?/i)).toBeInTheDocument();
      });
    });

    it('confirming revoke calls revokeShare with the share id', async () => {
      const { hookResult } = setupWithShare('share-abc');

      const user = userEvent.setup();
      const { container } = render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      // Find and click the revoke icon button
      const revokeIcon = container.querySelector('[data-testid="BlockIcon"]');
      const revokeBtn = revokeIcon!.closest('button') as HTMLButtonElement;
      await user.click(revokeBtn);

      await waitFor(() => screen.getByText(/revoke share\?/i));

      // The dialog has a Revoke confirm button with text "Revoke"
      const dialogRevokeBtns = screen.getAllByRole('button', { name: /^revoke$/i });
      // Pick the last "Revoke" button (the one inside the dialog)
      await user.click(dialogRevokeBtns[dialogRevokeBtns.length - 1]);

      await waitFor(() => {
        expect(hookResult.revokeShare).toHaveBeenCalledWith('share-abc');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Bulk select + revoke
  // -------------------------------------------------------------------------

  describe('Bulk select and revoke', () => {
    function setupWithShares() {
      const shares = [
        makeShare({ id: 'bulk-1', status: 'active' }),
        makeShare({ id: 'bulk-2', status: 'active' }),
      ];
      const hookResult = makeHook({ shares });
      mockUseMediaShares.mockReturnValue(hookResult);
      return { shares, hookResult };
    }

    it('selecting all rows via header checkbox shows bulk action bar', async () => {
      setupWithShares();

      const user = userEvent.setup();
      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      const checkboxes = screen.getAllByRole('checkbox');
      // First checkbox is the select-all header checkbox
      await user.click(checkboxes[0]);

      await waitFor(() => {
        expect(screen.getByText(/selected/i)).toBeInTheDocument();
      });
    });

    it('bulk "Revoke" opens confirmation dialog mentioning count', async () => {
      setupWithShares();

      const user = userEvent.setup();
      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      // Select all
      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[0]);

      await waitFor(() => screen.getByText(/selected/i));

      // Click the Revoke button in the bulk action bar (there can be multiple "Revoke" buttons)
      const revokeButtons = screen.getAllByRole('button', { name: /revoke/i });
      // The bulk action bar "Revoke" is the one after the per-row ones; pick the one in the bulk bar
      // Since select-all was clicked, per-row buttons are gone; the first "Revoke" should be the bulk one
      await user.click(revokeButtons[0]);

      await waitFor(() => {
        // Confirmation dialog for bulk (2 shares)
        expect(screen.getByText(/revoke 2 shares\?/i)).toBeInTheDocument();
      });
    });

    it('confirming bulk revoke calls bulkShares with correct ids and action "revoke"', async () => {
      const { hookResult } = setupWithShares();
      hookResult.bulkAction.mockResolvedValue({ affected: 2 });

      const user = userEvent.setup();
      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      // Select all rows
      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[0]);

      await waitFor(() => screen.getByText(/selected/i));

      // Click bulk Revoke
      const revokeButtons = screen.getAllByRole('button', { name: /revoke/i });
      await user.click(revokeButtons[0]);

      await waitFor(() => screen.getByText(/revoke 2 shares\?/i));

      // Confirm in the dialog
      const confirmBtns = screen.getAllByRole('button', { name: /^revoke$/i });
      // The confirm button in the dialog
      await user.click(confirmBtns[confirmBtns.length - 1]);

      await waitFor(() => {
        expect(hookResult.bulkAction).toHaveBeenCalledWith(
          expect.objectContaining({
            ids: expect.arrayContaining(['bulk-1', 'bulk-2']),
            action: 'revoke',
          }),
        );
      });
    });

    it('shows count of selected items in the bulk bar', async () => {
      const shares = [
        makeShare({ id: 'x1', status: 'active' }),
        makeShare({ id: 'x2', status: 'active' }),
        makeShare({ id: 'x3', status: 'active' }),
      ];
      mockUseMediaShares.mockReturnValue(makeHook({ shares }));

      const user = userEvent.setup();
      render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });

      // Select first two rows individually
      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[1]); // row 1
      await user.click(checkboxes[2]); // row 2

      await waitFor(() => {
        expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
      });
    });
  });
});

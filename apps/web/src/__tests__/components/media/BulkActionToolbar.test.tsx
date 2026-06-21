/**
 * BulkActionToolbar — unit tests.
 *
 * Mocks the media service so we don't need a real API.
 * Covers: render, cancel, select all, set location, tags,
 *         favorite, delete flows, and viewer role restrictions.
 *
 * UI shape (Immich-style icon bar):
 *   Left: Cancel selection (✕) icon button
 *   Centre: "{count} selected" typography
 *   Right: Select all icon button (always visible, even for viewer)
 *   Right (non-viewer): Add to favorites icon button
 *   Right (non-viewer): More actions icon button → overflow Menu
 *     Menu items: Set location, Edit tags, [Divider],
 *                 Remove from favorites, [optional Remove from album],
 *                 [Divider], Archive (home mode) / Unarchive (archive mode),
 *                 Move to Trash
 *   "Move to Trash" opens a confirmation Dialog (Cancel / Move to Trash buttons).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { BulkActionToolbar } from '../../../components/media/BulkActionToolbar';

// ---------------------------------------------------------------------------
// Mock media service bulk functions
// ---------------------------------------------------------------------------
vi.mock('../../../services/media', () => ({
  bulkUpdateMedia: vi.fn(),
  bulkDelete: vi.fn(),
  bulkArchive: vi.fn(),
  bulkUnarchive: vi.fn(),
  getDashboard: vi.fn(),
  listMedia: vi.fn(),
  getMedia: vi.fn(),
  patchMedia: vi.fn(),
  initUpload: vi.fn(),
  uploadPart: vi.fn(),
  completeUpload: vi.fn(),
  registerMedia: vi.fn(),
  listTags: vi.fn(),
  bulkTags: vi.fn(),
}));

import { bulkUpdateMedia, bulkDelete } from '../../../services/media';

const mockBulkUpdateMedia = vi.mocked(bulkUpdateMedia);
const mockBulkDelete = vi.mocked(bulkDelete);

// ---------------------------------------------------------------------------
// Default props
// ---------------------------------------------------------------------------
const defaultProps = {
  selected: new Set(['item-1', 'item-2']),
  circleId: 'circle-1',
  activeCircleRole: 'circle_admin' as const,
  onClear: vi.fn(),
  onSelectAll: vi.fn(),
  onOpenLocation: vi.fn(),
  onOpenTags: vi.fn(),
  onSuccess: vi.fn(),
  onError: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('BulkActionToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBulkUpdateMedia.mockResolvedValue({ updated: 2 });
    mockBulkDelete.mockResolvedValue({ deleted: 2 });
  });

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------
  describe('Visibility', () => {
    it('renders when selected count > 0', () => {
      render(<BulkActionToolbar {...defaultProps} />);
      expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
    });

    it('returns null when selected is empty', () => {
      const { container } = render(
        <BulkActionToolbar {...defaultProps} selected={new Set()} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('shows action buttons for non-viewer roles', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} activeCircleRole="circle_admin" />);

      // Direct icon buttons visible without opening any menu
      expect(screen.getByRole('button', { name: /add to favorites/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /select all/i })).toBeInTheDocument();

      // Overflow menu items require opening the menu first
      await user.click(screen.getByRole('button', { name: /more actions/i }));
      expect(screen.getByText(/set location/i)).toBeInTheDocument();
      expect(screen.getByText(/edit tags/i)).toBeInTheDocument();
      expect(screen.getByText(/move to trash/i)).toBeInTheDocument();
    });

    it('hides action buttons for viewer role', () => {
      render(<BulkActionToolbar {...defaultProps} activeCircleRole="viewer" />);

      // Non-viewer buttons must be absent
      expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /add to favorites/i })).not.toBeInTheDocument();

      // Select all is always visible, even for viewer
      expect(screen.getByRole('button', { name: /select all/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Cancel selection button
  // -------------------------------------------------------------------------
  describe('Cancel selection button', () => {
    it('calls onClear when Cancel selection is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /cancel selection/i }));
      expect(defaultProps.onClear).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Select all button
  // -------------------------------------------------------------------------
  describe('Select all button', () => {
    it('calls onSelectAll when Select all is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /select all/i }));
      expect(defaultProps.onSelectAll).toHaveBeenCalledTimes(1);
    });

    it('shows Select all button even for viewer role', () => {
      render(<BulkActionToolbar {...defaultProps} activeCircleRole="viewer" />);
      expect(screen.getByRole('button', { name: /select all/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Set Location (in overflow menu)
  // -------------------------------------------------------------------------
  describe('Set Location button', () => {
    it('calls onOpenLocation when Set location menu item is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/set location/i));
      expect(defaultProps.onOpenLocation).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Tags (in overflow menu)
  // -------------------------------------------------------------------------
  describe('Tags button', () => {
    it('calls onOpenTags when Edit tags menu item is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/edit tags/i));
      expect(defaultProps.onOpenTags).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Favorite actions
  // -------------------------------------------------------------------------
  describe('Favorite actions', () => {
    it('calls bulkUpdateMedia with favorite: true when Add to favorites icon button is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /add to favorites/i }));

      await waitFor(() => {
        expect(mockBulkUpdateMedia).toHaveBeenCalledWith(
          expect.objectContaining({ set: { favorite: true } }),
        );
      });
    });

    it('calls bulkUpdateMedia with favorite: false when Remove from favorites menu item is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/remove from favorites/i));

      await waitFor(() => {
        expect(mockBulkUpdateMedia).toHaveBeenCalledWith(
          expect.objectContaining({ set: { favorite: false } }),
        );
      });
    });

    it('calls onError when favorite update fails', async () => {
      mockBulkUpdateMedia.mockRejectedValueOnce(new Error('Favorite failed'));
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /add to favorites/i }));

      await waitFor(() => {
        expect(defaultProps.onError).toHaveBeenCalledWith('Favorite failed');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Delete flow (Move to Trash)
  // -------------------------------------------------------------------------
  describe('Delete flow', () => {
    it('opens delete confirmation dialog when Move to Trash menu item is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      // The menu item is a MenuItem (role="menuitem"), not a button
      await user.click(screen.getByRole('menuitem', { name: /move to trash/i }));
      expect(screen.getByText(/move 2 items to trash\?/i)).toBeInTheDocument();
    });

    it('calls bulkDelete when confirmation Move to Trash button is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      // Open overflow menu and trigger delete dialog
      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /move to trash/i }));

      // Confirmation dialog appears — click the confirm button (a Button, not a menuitem)
      const confirmBtn = screen.getByRole('button', { name: /move to trash/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(mockBulkDelete).toHaveBeenCalledWith({
          circleId: 'circle-1',
          ids: expect.arrayContaining(['item-1', 'item-2']),
        });
      });
    });

    it('calls onSuccess after successful delete', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /move to trash/i }));
      const confirmBtn = screen.getByRole('button', { name: /move to trash/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/moved 2 items to trash/i),
        );
      });
    });

    it('calls onError when delete fails', async () => {
      mockBulkDelete.mockRejectedValueOnce(new Error('Delete failed'));
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /move to trash/i }));
      const confirmBtn = screen.getByRole('button', { name: /move to trash/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(defaultProps.onError).toHaveBeenCalledWith('Delete failed');
      });
    });

    it('closes confirmation dialog when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /move to trash/i }));
      expect(screen.getByText(/move 2 items to trash\?/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByText(/move 2 items to trash\?/i)).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Singular count
  // -------------------------------------------------------------------------
  describe('Singular count handling', () => {
    it('uses singular "item" when only 1 item is selected', async () => {
      mockBulkDelete.mockResolvedValue({ deleted: 1 });
      const user = userEvent.setup();
      render(
        <BulkActionToolbar {...defaultProps} selected={new Set(['item-1'])} />,
      );

      expect(screen.getByText(/1 selected/i)).toBeInTheDocument();

      // Verify delete confirm dialog uses singular via the overflow menu
      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /move to trash/i }));
      expect(screen.getByText(/move 1 item to trash\?/i)).toBeInTheDocument();
    });
  });
});

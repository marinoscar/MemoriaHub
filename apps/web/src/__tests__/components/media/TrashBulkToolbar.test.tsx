/**
 * TrashBulkToolbar — unit tests.
 *
 * Covers: render, cancel, select all, restore action, delete-forever flow,
 * viewer role restrictions, confirm dialog says "permanent" not "Trash".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { TrashBulkToolbar } from '../../../components/media/TrashBulkToolbar';

// ---------------------------------------------------------------------------
// Mock media service
// ---------------------------------------------------------------------------
vi.mock('../../../services/media', () => ({
  restoreFromTrash: vi.fn(),
  deleteForever: vi.fn(),
}));

import { restoreFromTrash, deleteForever } from '../../../services/media';

const mockRestoreFromTrash = vi.mocked(restoreFromTrash);
const mockDeleteForever = vi.mocked(deleteForever);

// ---------------------------------------------------------------------------
// Default props
// ---------------------------------------------------------------------------
const defaultProps = {
  selected: new Set(['item-1', 'item-2']),
  circleId: 'circle-1',
  activeCircleRole: 'circle_admin' as const,
  onClear: vi.fn(),
  onSelectAll: vi.fn(),
  onSuccess: vi.fn(),
  onError: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('TrashBulkToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRestoreFromTrash.mockResolvedValue({ restored: 2, conflicts: [] });
    mockDeleteForever.mockResolvedValue({ deleted: 2 });
  });

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------
  describe('Visibility', () => {
    it('renders with selected count', () => {
      render(<TrashBulkToolbar {...defaultProps} />);
      expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
    });

    it('returns null when selected is empty', () => {
      const { container } = render(
        <TrashBulkToolbar {...defaultProps} selected={new Set()} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('shows action buttons for non-viewer roles', () => {
      render(<TrashBulkToolbar {...defaultProps} activeCircleRole="circle_admin" />);
      expect(screen.getByRole('button', { name: /restore selected/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /more actions/i })).toBeInTheDocument();
    });

    it('hides action buttons for viewer role', () => {
      render(<TrashBulkToolbar {...defaultProps} activeCircleRole="viewer" />);
      expect(screen.queryByRole('button', { name: /restore selected/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
    });

    it('always shows Select all button for viewer role', () => {
      render(<TrashBulkToolbar {...defaultProps} activeCircleRole="viewer" />);
      expect(screen.getByRole('button', { name: /select all/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Cancel selection
  // -------------------------------------------------------------------------
  describe('Cancel selection button', () => {
    it('calls onClear when clicked', async () => {
      const user = userEvent.setup();
      render(<TrashBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /cancel selection/i }));
      expect(defaultProps.onClear).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Restore action
  // -------------------------------------------------------------------------
  describe('Restore action', () => {
    it('calls restoreFromTrash with the correct payload', async () => {
      const user = userEvent.setup();
      render(<TrashBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /restore selected/i }));

      await waitFor(() => {
        expect(mockRestoreFromTrash).toHaveBeenCalledWith({
          circleId: 'circle-1',
          ids: expect.arrayContaining(['item-1', 'item-2']),
        });
      });
    });

    it('calls onSuccess with restored count on success (no conflicts)', async () => {
      const user = userEvent.setup();
      render(<TrashBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /restore selected/i }));

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/restored 2 items/i),
        );
      });
    });

    it('mentions conflicts in onSuccess message when some could not be restored', async () => {
      mockRestoreFromTrash.mockResolvedValue({ restored: 1, conflicts: ['item-2'] });
      const user = userEvent.setup();
      render(<TrashBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /restore selected/i }));

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/1 item.* could not be restored/i),
        );
      });
    });

    it('calls onError when restoreFromTrash fails', async () => {
      mockRestoreFromTrash.mockRejectedValueOnce(new Error('Restore failed'));
      const user = userEvent.setup();
      render(<TrashBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /restore selected/i }));

      await waitFor(() => {
        expect(defaultProps.onError).toHaveBeenCalledWith('Restore failed');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Delete forever flow
  // -------------------------------------------------------------------------
  describe('Delete forever flow', () => {
    it('opens confirm dialog when Delete forever menu item is clicked', async () => {
      const user = userEvent.setup();
      render(<TrashBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/delete forever/i));

      expect(screen.getByText(/delete 2 items forever\?/i)).toBeInTheDocument();
    });

    it('confirm dialog mentions "cannot be undone" (permanent, not trash)', async () => {
      const user = userEvent.setup();
      render(<TrashBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/delete forever/i));

      expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    });

    it('calls deleteForever and onSuccess when confirmed', async () => {
      const user = userEvent.setup();
      render(<TrashBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/delete forever/i));

      const confirmBtns = screen.getAllByRole('button', { name: /delete forever/i });
      await user.click(confirmBtns[confirmBtns.length - 1]);

      await waitFor(() => {
        expect(mockDeleteForever).toHaveBeenCalledWith({
          circleId: 'circle-1',
          ids: expect.arrayContaining(['item-1', 'item-2']),
        });
      });

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/permanently deleted 2 items/i),
        );
      });
    });

    it('calls onError when deleteForever fails', async () => {
      mockDeleteForever.mockRejectedValueOnce(new Error('Permanent delete failed'));
      const user = userEvent.setup();
      render(<TrashBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/delete forever/i));

      const confirmBtns = screen.getAllByRole('button', { name: /delete forever/i });
      await user.click(confirmBtns[confirmBtns.length - 1]);

      await waitFor(() => {
        expect(defaultProps.onError).toHaveBeenCalled();
      });
    });

    it('closes dialog when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<TrashBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/delete forever/i));
      expect(screen.getByText(/delete 2 items forever\?/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByText(/delete 2 items forever\?/i)).not.toBeInTheDocument();
      });
    });
  });
});

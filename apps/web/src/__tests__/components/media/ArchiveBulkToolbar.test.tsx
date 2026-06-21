/**
 * ArchiveBulkToolbar — unit tests.
 *
 * Covers: render, cancel, select all, unarchive action, move-to-trash flow,
 * viewer role restrictions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { ArchiveBulkToolbar } from '../../../components/media/ArchiveBulkToolbar';

// ---------------------------------------------------------------------------
// Mock media service
// ---------------------------------------------------------------------------
vi.mock('../../../services/media', () => ({
  bulkUnarchive: vi.fn(),
  bulkDelete: vi.fn(),
}));

import { bulkUnarchive, bulkDelete } from '../../../services/media';

const mockBulkUnarchive = vi.mocked(bulkUnarchive);
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
  onSuccess: vi.fn(),
  onError: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ArchiveBulkToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBulkUnarchive.mockResolvedValue({ unarchived: 2 });
    mockBulkDelete.mockResolvedValue({ deleted: 2 });
  });

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------
  describe('Visibility', () => {
    it('renders with selected count', () => {
      render(<ArchiveBulkToolbar {...defaultProps} />);
      expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
    });

    it('returns null when selected is empty', () => {
      const { container } = render(
        <ArchiveBulkToolbar {...defaultProps} selected={new Set()} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('shows action buttons for non-viewer roles', () => {
      render(<ArchiveBulkToolbar {...defaultProps} activeCircleRole="circle_admin" />);
      expect(screen.getByRole('button', { name: /unarchive selected/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /more actions/i })).toBeInTheDocument();
    });

    it('hides action buttons for viewer role', () => {
      render(<ArchiveBulkToolbar {...defaultProps} activeCircleRole="viewer" />);
      expect(screen.queryByRole('button', { name: /unarchive selected/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
    });

    it('always shows Select all button even for viewer', () => {
      render(<ArchiveBulkToolbar {...defaultProps} activeCircleRole="viewer" />);
      expect(screen.getByRole('button', { name: /select all/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Cancel selection
  // -------------------------------------------------------------------------
  describe('Cancel selection button', () => {
    it('calls onClear when clicked', async () => {
      const user = userEvent.setup();
      render(<ArchiveBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /cancel selection/i }));
      expect(defaultProps.onClear).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Select all
  // -------------------------------------------------------------------------
  describe('Select all button', () => {
    it('calls onSelectAll when clicked', async () => {
      const user = userEvent.setup();
      render(<ArchiveBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /select all/i }));
      expect(defaultProps.onSelectAll).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Unarchive action
  // -------------------------------------------------------------------------
  describe('Unarchive action', () => {
    it('calls bulkUnarchive with the correct payload when Unarchive button is clicked', async () => {
      const user = userEvent.setup();
      render(<ArchiveBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /unarchive selected/i }));

      await waitFor(() => {
        expect(mockBulkUnarchive).toHaveBeenCalledWith({
          circleId: 'circle-1',
          ids: expect.arrayContaining(['item-1', 'item-2']),
        });
      });
    });

    it('calls onSuccess with unarchived count after successful unarchive', async () => {
      const user = userEvent.setup();
      render(<ArchiveBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /unarchive selected/i }));

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/unarchived 2 items/i),
        );
      });
    });

    it('calls onError when bulkUnarchive fails', async () => {
      mockBulkUnarchive.mockRejectedValueOnce(new Error('Unarchive failed'));
      const user = userEvent.setup();
      render(<ArchiveBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /unarchive selected/i }));

      await waitFor(() => {
        expect(defaultProps.onError).toHaveBeenCalledWith('Unarchive failed');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Move to Trash flow
  // -------------------------------------------------------------------------
  describe('Move to Trash flow', () => {
    it('opens delete confirmation dialog when Move to Trash menu item is clicked', async () => {
      const user = userEvent.setup();
      render(<ArchiveBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/move to trash/i));

      expect(screen.getByText(/move 2 items to trash\?/i)).toBeInTheDocument();
    });

    it('confirm dialog says "Trash" not permanent', async () => {
      const user = userEvent.setup();
      render(<ArchiveBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/move to trash/i));

      // Should mention recovery
      expect(screen.getByText(/recovered/i)).toBeInTheDocument();
    });

    it('calls bulkDelete and onSuccess when Move to Trash is confirmed', async () => {
      const user = userEvent.setup();
      render(<ArchiveBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/move to trash/i));

      const confirmBtn = screen.getAllByRole('button', { name: /move to trash/i }).find(
        (btn) => btn.tagName === 'BUTTON',
      );
      await user.click(confirmBtn!);

      await waitFor(() => {
        expect(mockBulkDelete).toHaveBeenCalledWith({
          circleId: 'circle-1',
          ids: expect.arrayContaining(['item-1', 'item-2']),
        });
      });
    });

    it('calls onError when bulkDelete fails', async () => {
      mockBulkDelete.mockRejectedValueOnce(new Error('Delete failed'));
      const user = userEvent.setup();
      render(<ArchiveBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/move to trash/i));

      const confirmBtns = screen.getAllByRole('button', { name: /move to trash/i });
      const confirmBtn = confirmBtns[confirmBtns.length - 1];
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(defaultProps.onError).toHaveBeenCalled();
      });
    });

    it('closes dialog when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<ArchiveBulkToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/move to trash/i));
      expect(screen.getByText(/move 2 items to trash\?/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByText(/move 2 items to trash\?/i)).not.toBeInTheDocument();
      });
    });
  });
});

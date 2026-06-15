/**
 * BulkActionToolbar — unit tests.
 *
 * Mocks the media service so we don't need a real API.
 * Covers: render, clear, set location, tags, classify, favorite, delete flows.
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

    it('shows action buttons for non-viewer roles', () => {
      render(<BulkActionToolbar {...defaultProps} activeCircleRole="circle_admin" />);
      expect(screen.getByRole('button', { name: /set location/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /tags/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /classification/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /favorite/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    });

    it('hides action buttons for viewer role', () => {
      render(<BulkActionToolbar {...defaultProps} activeCircleRole="viewer" />);
      expect(screen.queryByRole('button', { name: /set location/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Clear button
  // -------------------------------------------------------------------------
  describe('Clear button', () => {
    it('calls onClear when Clear is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /clear/i }));
      expect(defaultProps.onClear).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Set Location button
  // -------------------------------------------------------------------------
  describe('Set Location button', () => {
    it('calls onOpenLocation when Set Location is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /set location/i }));
      expect(defaultProps.onOpenLocation).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Tags button
  // -------------------------------------------------------------------------
  describe('Tags button', () => {
    it('calls onOpenTags when Tags is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /^tags$/i }));
      expect(defaultProps.onOpenTags).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Classification menu
  // -------------------------------------------------------------------------
  describe('Classification menu', () => {
    it('opens classification menu when Classification is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /classification/i }));
      expect(screen.getByText(/^memory$/i)).toBeInTheDocument();
      expect(screen.getByText(/low value/i)).toBeInTheDocument();
      expect(screen.getByText(/unreviewed/i)).toBeInTheDocument();
    });

    it('calls bulkUpdateMedia with "memory" when Memory is selected', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /classification/i }));
      await user.click(screen.getByText(/^memory$/i));

      await waitFor(() => {
        expect(mockBulkUpdateMedia).toHaveBeenCalledWith({
          circleId: 'circle-1',
          ids: expect.arrayContaining(['item-1', 'item-2']),
          set: { classification: 'memory' },
        });
      });
    });

    it('calls bulkUpdateMedia with "low_value" when Low Value is selected', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /classification/i }));
      await user.click(screen.getByText(/low value/i));

      await waitFor(() => {
        expect(mockBulkUpdateMedia).toHaveBeenCalledWith(
          expect.objectContaining({ set: { classification: 'low_value' } }),
        );
      });
    });

    it('calls bulkUpdateMedia with "unreviewed" when Unreviewed is selected', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /classification/i }));
      await user.click(screen.getByText(/unreviewed/i));

      await waitFor(() => {
        expect(mockBulkUpdateMedia).toHaveBeenCalledWith(
          expect.objectContaining({ set: { classification: 'unreviewed' } }),
        );
      });
    });

    it('calls onSuccess after successful classify', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /classification/i }));
      await user.click(screen.getByText(/^memory$/i));

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/updated classification/i),
        );
      });
    });

    it('calls onError when classify fails', async () => {
      mockBulkUpdateMedia.mockRejectedValueOnce(new Error('API error'));
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /classification/i }));
      await user.click(screen.getByText(/^memory$/i));

      await waitFor(() => {
        expect(defaultProps.onError).toHaveBeenCalledWith('API error');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Favorite menu
  // -------------------------------------------------------------------------
  describe('Favorite menu', () => {
    it('opens favorite menu when Favorite is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /favorite/i }));
      expect(screen.getByText(/add to favorites/i)).toBeInTheDocument();
      expect(screen.getByText(/remove from favorites/i)).toBeInTheDocument();
    });

    it('calls bulkUpdateMedia with favorite: true when Add is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /favorite/i }));
      await user.click(screen.getByText(/add to favorites/i));

      await waitFor(() => {
        expect(mockBulkUpdateMedia).toHaveBeenCalledWith(
          expect.objectContaining({ set: { favorite: true } }),
        );
      });
    });

    it('calls bulkUpdateMedia with favorite: false when Remove is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /favorite/i }));
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

      await user.click(screen.getByRole('button', { name: /favorite/i }));
      await user.click(screen.getByText(/add to favorites/i));

      await waitFor(() => {
        expect(defaultProps.onError).toHaveBeenCalledWith('Favorite failed');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Delete flow
  // -------------------------------------------------------------------------
  describe('Delete flow', () => {
    it('opens delete confirmation dialog when Delete is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /delete/i }));
      expect(screen.getByText(/delete 2 items\?/i)).toBeInTheDocument();
    });

    it('calls bulkDelete when confirmation Delete button is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      // Confirmation dialog appears — click the confirm button
      const confirmBtn = screen.getByRole('button', { name: /^delete$/i });
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

      await user.click(screen.getByRole('button', { name: /^delete$/i }));
      const confirmBtn = screen.getByRole('button', { name: /^delete$/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/deleted 2 items/i),
        );
      });
    });

    it('calls onError when delete fails', async () => {
      mockBulkDelete.mockRejectedValueOnce(new Error('Delete failed'));
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /^delete$/i }));
      const confirmBtn = screen.getByRole('button', { name: /^delete$/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(defaultProps.onError).toHaveBeenCalledWith('Delete failed');
      });
    });

    it('closes confirmation dialog when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /^delete$/i }));
      expect(screen.getByText(/delete 2 items\?/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByText(/delete 2 items\?/i)).not.toBeInTheDocument();
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

      // Verify delete confirm dialog uses singular
      await user.click(screen.getByRole('button', { name: /delete/i }));
      expect(screen.getByText(/delete 1 item\?/i)).toBeInTheDocument();
    });
  });
});

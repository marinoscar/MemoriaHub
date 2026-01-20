import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddExistingMediaDialog } from './AddExistingMediaDialog';
import { createMockMedia } from '../../test/test-helpers';
import type { MediaAssetDTO } from '@memoriahub/shared';

// Mock the useAllMedia hook
const mockLoadMore = vi.fn();
const mockUseAllMedia = vi.fn();

vi.mock('../../hooks/useAllMedia', () => ({
  useAllMedia: () => mockUseAllMedia(),
}));

// Mock media data
const mockMedia: MediaAssetDTO[] = [
  createMockMedia('media-1', { originalFilename: 'photo1.jpg' }),
  createMockMedia('media-2', { originalFilename: 'photo2.jpg' }),
  createMockMedia('media-3', { originalFilename: 'photo3.jpg' }),
  createMockMedia('media-4', { originalFilename: 'video1.mp4', mediaType: 'video' }),
  createMockMedia('media-5', { originalFilename: 'photo4.jpg' }),
];

describe('AddExistingMediaDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAllMedia.mockReturnValue({
      media: mockMedia,
      isLoading: false,
      isLoadingMore: false,
      hasMore: false,
      loadMore: mockLoadMore,
      error: null,
    });
  });

  describe('rendering', () => {
    it('renders when open', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText('Add Existing Media')).toBeInTheDocument();
      expect(screen.getByText(/Select media to add to "Family Photos"/)).toBeInTheDocument();
    });

    it('does not render when closed', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={false}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.queryByText('Add Existing Media')).not.toBeInTheDocument();
    });

    it('displays available media count', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText('5 available')).toBeInTheDocument();
    });

    it('shows cancel and add buttons', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /to Library/i })).toBeInTheDocument();
    });

    it('shows close button in header', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    });

    it('renders media grid with selectable cards', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Should render all 5 mock media items
      const images = screen.getAllByRole('img');
      expect(images.length).toBeGreaterThanOrEqual(5);
    });

    it('shows select all checkbox', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByRole('checkbox', { name: 'Select all media' })).toBeInTheDocument();
    });
  });

  describe('loading state', () => {
    it('shows loading skeleton when loading and no media', () => {
      mockUseAllMedia.mockReturnValue({
        media: [],
        isLoading: true,
        isLoadingMore: false,
        hasMore: false,
        loadMore: mockLoadMore,
        error: null,
      });

      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // GallerySkeleton renders skeleton items
      expect(screen.queryByText('5 available')).not.toBeInTheDocument();
    });

    it('shows Load More button when hasMore is true', () => {
      mockUseAllMedia.mockReturnValue({
        media: mockMedia,
        isLoading: false,
        isLoadingMore: false,
        hasMore: true,
        loadMore: mockLoadMore,
        error: null,
      });

      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText('Load More')).toBeInTheDocument();
    });

    it('shows loading state on Load More button when loading more', () => {
      mockUseAllMedia.mockReturnValue({
        media: mockMedia,
        isLoading: false,
        isLoadingMore: true,
        hasMore: true,
        loadMore: mockLoadMore,
        error: null,
      });

      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows empty state when no media available', () => {
      mockUseAllMedia.mockReturnValue({
        media: [],
        isLoading: false,
        isLoadingMore: false,
        hasMore: false,
        loadMore: mockLoadMore,
        error: null,
      });

      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText('No media available to add')).toBeInTheDocument();
      expect(screen.getByText('Upload some photos or videos first.')).toBeInTheDocument();
    });

    it('shows different message when all media already in library', () => {
      mockUseAllMedia.mockReturnValue({
        media: mockMedia,
        isLoading: false,
        isLoadingMore: false,
        hasMore: false,
        loadMore: mockLoadMore,
        error: null,
      });

      const onClose = vi.fn();
      const onAdd = vi.fn();
      const existingAssetIds = new Set(mockMedia.map((m) => m.id));

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          existingAssetIds={existingAssetIds}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText('No media available to add')).toBeInTheDocument();
      expect(screen.getByText('All your media is already in this library.')).toBeInTheDocument();
    });
  });

  describe('filtering existing assets', () => {
    it('filters out media already in the library', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();
      const existingAssetIds = new Set(['media-1', 'media-2']);

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          existingAssetIds={existingAssetIds}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Should show 3 available (5 total - 2 existing)
      expect(screen.getByText('3 available')).toBeInTheDocument();
    });
  });

  describe('selection', () => {
    it('allows selecting individual media items by clicking card', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Click on a media card to toggle selection (cards have role="button")
      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]);

      expect(screen.getByText('1 selected')).toBeInTheDocument();
    });

    it('updates selected count when multiple items selected', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Click on multiple media cards
      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]);
      fireEvent.click(mediaCards[1]);
      fireEvent.click(mediaCards[2]);

      expect(screen.getByText('3 selected')).toBeInTheDocument();
    });

    it('allows deselecting items', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      // Select then deselect by clicking again
      fireEvent.click(mediaCards[0]);
      expect(screen.getByText('1 selected')).toBeInTheDocument();

      fireEvent.click(mediaCards[0]);
      expect(screen.getByText('5 available')).toBeInTheDocument();
    });

    it('selects all when select all checkbox is clicked', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const selectAllCheckbox = screen.getByRole('checkbox', { name: 'Select all media' });
      fireEvent.click(selectAllCheckbox);

      expect(screen.getByText('5 selected')).toBeInTheDocument();
    });

    it('deselects all when select all is clicked again', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const selectAllCheckbox = screen.getByRole('checkbox', { name: 'Select all media' });
      // Select all
      fireEvent.click(selectAllCheckbox);
      expect(screen.getByText('5 selected')).toBeInTheDocument();

      // Deselect all
      fireEvent.click(selectAllCheckbox);
      expect(screen.getByText('5 available')).toBeInTheDocument();
    });

    it('shows indeterminate state on select all when some items selected', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Click on a media card to select one item
      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]);

      const selectAllCheckbox = screen.getByRole('checkbox', { name: 'Select all media' });
      // MUI checkbox should have data-indeterminate attribute when indeterminate
      expect(selectAllCheckbox).toHaveAttribute('data-indeterminate', 'true');
    });
  });

  describe('interaction', () => {
    it('calls onClose when Cancel is clicked', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when close button is clicked', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const closeButton = screen.getByRole('button', { name: 'Close' });
      fireEvent.click(closeButton);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onAdd with selected asset IDs when Add is clicked', async () => {
      const onClose = vi.fn();
      const onAdd = vi.fn().mockResolvedValue(undefined);

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Select some items by clicking cards
      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]); // media-1
      fireEvent.click(mediaCards[1]); // media-2

      // Click add button
      const addButton = screen.getByRole('button', { name: /to Library/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(onAdd).toHaveBeenCalledTimes(1);
        expect(onAdd).toHaveBeenCalledWith(expect.arrayContaining(['media-1', 'media-2']));
      });
    });

    it('closes dialog after successful add', async () => {
      const onClose = vi.fn();
      const onAdd = vi.fn().mockResolvedValue(undefined);

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Select and add
      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]);

      const addButton = screen.getByRole('button', { name: /to Library/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    });

    it('calls loadMore when Load More button is clicked', () => {
      mockUseAllMedia.mockReturnValue({
        media: mockMedia,
        isLoading: false,
        isLoadingMore: false,
        hasMore: true,
        loadMore: mockLoadMore,
        error: null,
      });

      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const loadMoreButton = screen.getByText('Load More');
      fireEvent.click(loadMoreButton);

      expect(mockLoadMore).toHaveBeenCalledTimes(1);
    });

    it('resets selection when dialog is closed', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      const { rerender } = render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Select some items by clicking cards
      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]);
      expect(screen.getByText('1 selected')).toBeInTheDocument();

      // Click cancel
      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);

      // Reopen dialog
      rerender(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Selection should be cleared
      expect(screen.getByText('5 available')).toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('shows error alert when fetch fails', () => {
      mockUseAllMedia.mockReturnValue({
        media: [],
        isLoading: false,
        isLoadingMore: false,
        hasMore: false,
        loadMore: mockLoadMore,
        error: 'Failed to fetch media',
      });

      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText('Failed to fetch media')).toBeInTheDocument();
    });

    it('shows error alert when add fails', async () => {
      const onClose = vi.fn();
      const onAdd = vi.fn().mockRejectedValue(new Error('Failed to add media'));

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Select and try to add
      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]);

      const addButton = screen.getByRole('button', { name: /to Library/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByText('Failed to add media')).toBeInTheDocument();
      });
    });

    it('does not close dialog when add fails', async () => {
      const onClose = vi.fn();
      const onAdd = vi.fn().mockRejectedValue(new Error('Failed to add media'));

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Select and try to add
      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]);

      const addButton = screen.getByRole('button', { name: /to Library/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByText('Failed to add media')).toBeInTheDocument();
      });

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('disables Add button when no items selected', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const addButton = screen.getByRole('button', { name: /to Library/i });
      expect(addButton).toBeDisabled();
    });

    it('enables Add button when items are selected', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]);

      const addButton = screen.getByRole('button', { name: /to Library/i });
      expect(addButton).not.toBeDisabled();
    });

    it('disables Add button while adding', async () => {
      const onClose = vi.fn();
      // Create a promise that we can control
      let resolveAdd: () => void;
      const addPromise = new Promise<void>((resolve) => {
        resolveAdd = resolve;
      });
      const onAdd = vi.fn().mockReturnValue(addPromise);

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Select and click add
      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]);

      const addButton = screen.getByRole('button', { name: /to Library/i });
      fireEvent.click(addButton);

      // Button should show loading state
      await waitFor(() => {
        expect(screen.getByText('Adding...')).toBeInTheDocument();
      });

      // Resolve the promise
      resolveAdd!();
    });

    it('disables Cancel button while adding', async () => {
      const onClose = vi.fn();
      let resolveAdd: () => void;
      const addPromise = new Promise<void>((resolve) => {
        resolveAdd = resolve;
      });
      const onAdd = vi.fn().mockReturnValue(addPromise);

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Select and click add
      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]);

      const addButton = screen.getByRole('button', { name: /to Library/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        const cancelButton = screen.getByText('Cancel');
        expect(cancelButton).toBeDisabled();
      });

      // Resolve the promise
      resolveAdd!();
    });
  });

  describe('accessibility', () => {
    it('has proper dialog role', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('has accessible select all checkbox', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByRole('checkbox', { name: 'Select all media' })).toBeInTheDocument();
    });

    it('has accessible close button', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    });
  });

  describe('button text', () => {
    it('shows correct button text with no selection', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByRole('button', { name: /to Library/i })).toBeInTheDocument();
    });

    it('shows count in button text when items selected', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddExistingMediaDialog
          open={true}
          libraryName="Family Photos"
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]);
      fireEvent.click(mediaCards[1]);
      fireEvent.click(mediaCards[2]);

      expect(screen.getByRole('button', { name: /Add 3 to Library/i })).toBeInTheDocument();
    });
  });
});

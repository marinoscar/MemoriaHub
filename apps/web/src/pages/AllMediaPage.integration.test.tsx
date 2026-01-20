import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AllMediaPage } from './AllMediaPage';
import { mediaApi } from '../services/api/media.api';
import { libraryApi } from '../services/api/library.api';
import { createMockMedia, createMockLibrary } from '../test/test-helpers';
import type { MediaAssetDTO, LibraryDTO } from '@memoriahub/shared';

// Mock the API modules
vi.mock('../services/api/media.api');
vi.mock('../services/api/library.api');

/**
 * Helper to get media card checkbox containers.
 * The actual toggle handler is on .checkbox-container, not the checkbox input.
 */
const getMediaCheckboxContainers = (container: HTMLElement): HTMLElement[] => {
  return Array.from(container.querySelectorAll('.checkbox-container'));
};

const mockMediaList: MediaAssetDTO[] = [
  createMockMedia('asset-1', { originalFilename: 'photo1.jpg' }),
  createMockMedia('asset-2', { originalFilename: 'photo2.jpg' }),
  createMockMedia('asset-3', { originalFilename: 'photo3.jpg' }),
  createMockMedia('asset-4', { originalFilename: 'photo4.jpg' }),
  createMockMedia('asset-5', { originalFilename: 'photo5.jpg' }),
];

const mockLibraries: LibraryDTO[] = [
  createMockLibrary('lib-1', 'Family Photos', {
    description: 'Family vacation photos',
    visibility: 'private',
    assetCount: 100,
  }),
  createMockLibrary('lib-2', 'Work Events', {
    description: 'Company events',
    visibility: 'shared',
    assetCount: 50,
  }),
];

// Mock functions (declared outside to be spied on)
const mockLoadMore = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
const mockRefreshMedia = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
const mockFetchLibraries = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
const mockCreateLibrary = vi.fn().mockResolvedValue({});
const mockUpdateLibrary = vi.fn().mockResolvedValue({});
const mockDeleteLibrary = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
const mockRefreshLibraries = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);

// Mock hook implementations
const mockUseAllMedia = {
  media: mockMediaList,
  isLoading: false,
  isLoadingMore: false,
  error: null as string | null,
  hasMore: false,
  total: mockMediaList.length,
  page: 1,
  limit: 50,
  loadMore: mockLoadMore as unknown as () => Promise<void>,
  refresh: mockRefreshMedia as unknown as () => Promise<void>,
};

const mockUseLibraries = {
  libraries: mockLibraries,
  isLoading: false,
  error: null as string | null,
  total: mockLibraries.length,
  page: 1,
  limit: 20,
  fetchLibraries: mockFetchLibraries as unknown as () => Promise<void>,
  createLibrary: mockCreateLibrary as unknown as () => Promise<any>,
  updateLibrary: mockUpdateLibrary as unknown as () => Promise<any>,
  deleteLibrary: mockDeleteLibrary as unknown as () => Promise<void>,
  refresh: mockRefreshLibraries as unknown as () => Promise<void>,
};

// Import hooks module for mocking
import * as useAllMediaModule from '../hooks/useAllMedia';
import * as useLibrariesModule from '../hooks/useLibraries';

describe('AllMediaPage - Integration Tests', () => {
  beforeEach(() => {
    // Setup hooks
    vi.spyOn(useAllMediaModule, 'useAllMedia').mockReturnValue(mockUseAllMedia as any);
    vi.spyOn(useLibrariesModule, 'useLibraries').mockReturnValue(mockUseLibraries as any);

    // Reset API mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('bulk selection workflow', () => {
    it('allows selecting multiple items and shows toolbar', () => {
      const { container } = render(<AllMediaPage />);

      // Initially no toolbar
      expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();

      // Select first item - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);

      // Toolbar should appear
      expect(screen.getByText('1 selected')).toBeInTheDocument();

      // Select second item
      fireEvent.click(checkboxContainers[1]);

      // Count should update
      expect(screen.getByText('2 selected')).toBeInTheDocument();
    });

    it('clears selection when close button is clicked', () => {
      const { container } = render(<AllMediaPage />);

      // Select items - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);
      fireEvent.click(checkboxContainers[1]);

      expect(screen.getByText('2 selected')).toBeInTheDocument();

      // Click close button on toolbar
      const closeButton = screen.getByTestId('CloseIcon').closest('button') as HTMLElement;
      fireEvent.click(closeButton);

      // Toolbar should disappear
      expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
    });

    it('maintains selection when items are toggled on and off', () => {
      const { container } = render(<AllMediaPage />);

      // Click checkbox containers, not inputs
      const checkboxContainers = getMediaCheckboxContainers(container);

      // Select 3 items
      fireEvent.click(checkboxContainers[0]);
      fireEvent.click(checkboxContainers[1]);
      fireEvent.click(checkboxContainers[2]);

      expect(screen.getByText('3 selected')).toBeInTheDocument();

      // Deselect middle item
      fireEvent.click(checkboxContainers[1]);

      expect(screen.getByText('2 selected')).toBeInTheDocument();

      // Reselect it
      fireEvent.click(checkboxContainers[1]);

      expect(screen.getByText('3 selected')).toBeInTheDocument();
    });
  });

  describe('add to library workflow', () => {
    it('opens add to library dialog when button is clicked', async () => {
      const { container } = render(<AllMediaPage />);

      // Select items - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);
      fireEvent.click(checkboxContainers[1]);

      // Click Add to Library button in toolbar
      const addButton = screen.getByRole('button', { name: /Add to Library/i });
      fireEvent.click(addButton);

      // Dialog should open
      await waitFor(() => {
        expect(screen.getByText(/Add 2 selected items to a library/i)).toBeInTheDocument();
      });
    });

    it('successfully adds items to library', async () => {
      // Mock successful API call
      vi.mocked(libraryApi.addAssets).mockResolvedValue([]);

      const { container } = render(<AllMediaPage />);

      // Select items - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);
      fireEvent.click(checkboxContainers[1]);

      // Open dialog
      const addButton = screen.getByRole('button', { name: /Add to Library/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByText(/Add 2 selected items to a library/i)).toBeInTheDocument();
      });

      // Select library
      const select = screen.getByLabelText(/Select Library/i);
      fireEvent.mouseDown(select);

      const libraryOption = screen.getByText('Family Photos');
      fireEvent.click(libraryOption);

      // Click Add button in dialog
      const dialogAddButtons = screen.getAllByRole('button', { name: /Add to Library/i });
      const dialogAddButton = dialogAddButtons[dialogAddButtons.length - 1];
      fireEvent.click(dialogAddButton!);

      // Verify API was called
      await waitFor(() => {
        expect(libraryApi.addAssets).toHaveBeenCalledWith('lib-1', ['asset-1', 'asset-2']);
      });

      // Success message should appear
      await waitFor(() => {
        expect(screen.getByText(/Added 2 items to library/i)).toBeInTheDocument();
      });

      // Selection should be cleared
      expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
    });

    it('shows error when add to library fails', async () => {
      // Mock failed API call
      vi.mocked(libraryApi.addAssets).mockRejectedValue(new Error('Network error'));

      const { container } = render(<AllMediaPage />);

      // Select items - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);

      // Open dialog and select library
      const addButton = screen.getByRole('button', { name: /Add to Library/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        const select = screen.getByLabelText(/Select Library/i);
        fireEvent.mouseDown(select);

        const libraryOption = screen.getByText('Family Photos');
        fireEvent.click(libraryOption);

        const dialogAddButtons = screen.getAllByRole('button', { name: /Add to Library/i });
        const dialogAddButton = dialogAddButtons[dialogAddButtons.length - 1];
        fireEvent.click(dialogAddButton!);
      });

      // Error message should appear (the actual error message from the Error object)
      await waitFor(() => {
        expect(screen.getByText(/Network error/i)).toBeInTheDocument();
      });
    });
  });

  describe('edit metadata workflow', () => {
    it('opens metadata dialog when button is clicked', async () => {
      const { container } = render(<AllMediaPage />);

      // Select items - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);
      fireEvent.click(checkboxContainers[1]);
      fireEvent.click(checkboxContainers[2]);

      // Click Edit Metadata button
      const editButton = screen.getByRole('button', { name: /Edit Metadata/i });
      fireEvent.click(editButton);

      // Dialog should open - check for dialog role and the "selected items" text
      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByText(/3 selected items/i)).toBeInTheDocument();
      });
    });

    it('successfully updates metadata', async () => {
      // Mock successful API call
      vi.mocked(mediaApi.bulkUpdateMetadata).mockResolvedValue({
        updated: ['asset-1', 'asset-2'],
        failed: [],
      });

      const { container } = render(<AllMediaPage />);

      // Select items - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);
      fireEvent.click(checkboxContainers[1]);

      // Open dialog
      const editButton = screen.getByRole('button', { name: /Edit Metadata/i });
      fireEvent.click(editButton);

      await waitFor(() => {
        // Check dialog is open using role
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      // Enable country field and set value - these are dialog checkboxes, not media card checkboxes
      const countryCheckbox = screen.getAllByRole('checkbox').find((cb) => {
        const label = cb.closest('div')?.textContent;
        return label?.includes('Country');
      });
      fireEvent.click(countryCheckbox!);

      // Get the text input for Country (not the checkbox)
      const countryInput = screen.getByRole('textbox', { name: /Country/i });
      fireEvent.change(countryInput, { target: { value: 'USA' } });

      // Click Apply
      const applyButton = screen.getByText(/Apply to 2 Items/i);
      fireEvent.click(applyButton);

      // Verify API was called
      await waitFor(() => {
        expect(mediaApi.bulkUpdateMetadata).toHaveBeenCalledWith({
          updates: [
            { assetId: 'asset-1', country: 'USA' },
            { assetId: 'asset-2', country: 'USA' },
          ],
        });
      });

      // Success message should appear
      await waitFor(() => {
        expect(screen.getByText(/Updated 2 items/i)).toBeInTheDocument();
      });
    });

    it('shows partial success message when some items fail', async () => {
      // Mock partial success
      vi.mocked(mediaApi.bulkUpdateMetadata).mockResolvedValue({
        updated: ['asset-1', 'asset-2'],
        failed: [{ assetId: 'asset-3', error: 'Permission denied' }],
      });

      const { container } = render(<AllMediaPage />);

      // Select 3 items - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);
      fireEvent.click(checkboxContainers[1]);
      fireEvent.click(checkboxContainers[2]);

      // Open dialog, enable field, set value, apply
      const editButton = screen.getByRole('button', { name: /Edit Metadata/i });
      fireEvent.click(editButton);

      await waitFor(async () => {
        // These are dialog checkboxes, not media card checkboxes
        const countryCheckbox = screen.getAllByRole('checkbox').find((cb) => {
          return cb.closest('div')?.textContent?.includes('Country');
        });
        fireEvent.click(countryCheckbox!);

        const countryInput = screen.getByRole('textbox', { name: /Country/i });
        fireEvent.change(countryInput, { target: { value: 'USA' } });

        const applyButton = screen.getByText(/Apply to 3 Items/i);
        fireEvent.click(applyButton);
      });

      // Should show partial success message
      await waitFor(() => {
        expect(screen.getByText(/Updated 2 items, 1 failed/i)).toBeInTheDocument();
      });
    });
  });

  describe('delete workflow', () => {
    it('opens delete confirmation dialog', async () => {
      const { container } = render(<AllMediaPage />);

      // Select items - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);
      fireEvent.click(checkboxContainers[1]);

      // Click Delete button
      const deleteButton = screen.getByText('Delete');
      fireEvent.click(deleteButton);

      // Confirmation dialog should open
      await waitFor(() => {
        expect(screen.getByText(/Are you sure you want to delete 2 selected items/i)).toBeInTheDocument();
        expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
      });
    });

    it('successfully deletes items', async () => {
      // Mock successful deletion
      vi.mocked(mediaApi.bulkDelete).mockResolvedValue({
        deleted: ['asset-1', 'asset-2', 'asset-3'],
        failed: [],
      });

      const { container } = render(<AllMediaPage />);

      // Select items - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);
      fireEvent.click(checkboxContainers[1]);
      fireEvent.click(checkboxContainers[2]);

      // Open delete dialog
      const deleteButton = screen.getByText('Delete');
      fireEvent.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByText(/Delete 3 Items/i)).toBeInTheDocument();
      });

      // Confirm deletion
      const confirmButton = screen.getByText(/Delete 3 Items/i);
      fireEvent.click(confirmButton);

      // Verify API was called
      await waitFor(() => {
        expect(mediaApi.bulkDelete).toHaveBeenCalledWith({
          assetIds: ['asset-1', 'asset-2', 'asset-3'],
        });
      });

      // Success message should appear
      await waitFor(() => {
        expect(screen.getByText(/Deleted 3 items/i)).toBeInTheDocument();
      });

      // Selection should be cleared
      expect(screen.queryByText('3 selected')).not.toBeInTheDocument();
    });

    it('cancels deletion when Cancel is clicked', async () => {
      const { container } = render(<AllMediaPage />);

      // Select items - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);

      // Open delete dialog
      const deleteButton = screen.getByText('Delete');
      fireEvent.click(deleteButton);

      await waitFor(() => {
        expect(screen.getByText(/Delete 1 Item/i)).toBeInTheDocument();
      });

      // Click Cancel
      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);

      // Dialog should close without calling API
      await waitFor(() => {
        expect(screen.queryByText(/Are you sure/i)).not.toBeInTheDocument();
      });

      expect(mediaApi.bulkDelete).not.toHaveBeenCalled();

      // Selection should remain
      expect(screen.getByText('1 selected')).toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('displays error message when bulk operation fails', async () => {
      vi.mocked(mediaApi.bulkUpdateMetadata).mockRejectedValue(new Error('Server error'));

      const { container } = render(<AllMediaPage />);

      // Select items - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);

      const editButton = screen.getByRole('button', { name: /Edit Metadata/i });
      fireEvent.click(editButton);

      await waitFor(async () => {
        // These are dialog checkboxes, not media card checkboxes
        const countryCheckbox = screen.getAllByRole('checkbox').find((cb) => {
          return cb.closest('div')?.textContent?.includes('Country');
        });
        fireEvent.click(countryCheckbox!);

        const countryInput = screen.getByRole('textbox', { name: /Country/i });
        fireEvent.change(countryInput, { target: { value: 'USA' } });

        const applyButton = screen.getByText(/Apply to 1 Item/i);
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        // The actual error message from the Error object
        expect(screen.getByText(/Server error/i)).toBeInTheDocument();
      });
    });

    it('refreshes media after successful operations', async () => {
      vi.mocked(libraryApi.addAssets).mockResolvedValue([]);

      const { container } = render(<AllMediaPage />);

      // Select items - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);

      const addButton = screen.getByRole('button', { name: /Add to Library/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        const select = screen.getByLabelText(/Select Library/i);
        fireEvent.mouseDown(select);

        const libraryOption = screen.getByText('Family Photos');
        fireEvent.click(libraryOption);

        // After dialog opens, there are two "Add to Library" buttons - use getAllByRole
        const dialogAddButtons = screen.getAllByRole('button', { name: /Add to Library/i });
        fireEvent.click(dialogAddButtons[dialogAddButtons.length - 1]); // Last one is the dialog button
      });

      // Refresh should be called
      await waitFor(() => {
        expect(mockRefreshMedia).toHaveBeenCalled();
      });
    });
  });

  describe('edge cases', () => {
    it('handles empty media list', () => {
      vi.spyOn(useAllMediaModule, 'useAllMedia').mockReturnValue({
        ...mockUseAllMedia,
        media: [],
        total: 0,
      } as any);

      render(<AllMediaPage />);

      // EmptyGallery component shows this message
      expect(screen.getByText(/No photos or videos yet/i)).toBeInTheDocument();
      expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();
    });

    it('handles loading state', () => {
      vi.spyOn(useAllMediaModule, 'useAllMedia').mockReturnValue({
        ...mockUseAllMedia,
        isLoading: true,
        media: [],
      } as any);

      const { container } = render(<AllMediaPage />);

      // Loading state shows skeletons (GallerySkeleton component)
      const skeletons = container.querySelectorAll('.MuiSkeleton-root');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it('handles no libraries available', async () => {
      vi.spyOn(useLibrariesModule, 'useLibraries').mockReturnValue({
        ...mockUseLibraries,
        libraries: [],
      } as any);

      const { container } = render(<AllMediaPage />);

      // Select items - click checkbox container, not input
      const checkboxContainers = getMediaCheckboxContainers(container);
      fireEvent.click(checkboxContainers[0]);

      const addButton = screen.getByRole('button', { name: /Add to Library/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByText(/You don't have any libraries/i)).toBeInTheDocument();
      });
    });
  });
});

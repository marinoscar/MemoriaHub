import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AllMediaPage } from '../AllMediaPage';
import { mediaApi } from '../../services/api/media.api';
import { libraryApi } from '../../services/api/library.api';
import type { MediaAssetDTO, LibraryDTO } from '@memoriahub/shared';

// Mock the API modules
vi.mock('../../services/api/media.api');
vi.mock('../../services/api/library.api');
vi.mock('../../hooks/useAllMedia');
vi.mock('../../hooks/useLibraries');

// Mock media data
const createMockMedia = (id: string, filename: string): MediaAssetDTO => ({
  id,
  userId: 'user-1',
  libraryId: null,
  filename,
  originalFilename: filename,
  mimeType: 'image/jpeg',
  fileSize: 1024000,
  storageBucket: 'test-bucket',
  storageKey: `test/${id}.jpg`,
  thumbnailUrl: `https://example.com/${id}-thumb.jpg`,
  previewUrl: `https://example.com/${id}-preview.jpg`,
  fullUrl: `https://example.com/${id}-full.jpg`,
  status: 'ready',
  width: 1920,
  height: 1080,
  capturedAtUtc: '2024-01-01T12:00:00Z',
  latitude: null,
  longitude: null,
  country: null,
  state: null,
  city: null,
  locationName: null,
  cameraMake: null,
  cameraModel: null,
  fNumber: null,
  exposureTime: null,
  focalLength: null,
  iso: null,
  createdAt: '2024-01-01T12:00:00Z',
  updatedAt: '2024-01-01T12:00:00Z',
});

const mockMediaList: MediaAssetDTO[] = [
  createMockMedia('asset-1', 'photo1.jpg'),
  createMockMedia('asset-2', 'photo2.jpg'),
  createMockMedia('asset-3', 'photo3.jpg'),
  createMockMedia('asset-4', 'photo4.jpg'),
  createMockMedia('asset-5', 'photo5.jpg'),
];

const mockLibraries: LibraryDTO[] = [
  {
    id: 'lib-1',
    userId: 'user-1',
    name: 'Family Photos',
    description: 'Family vacation photos',
    visibility: 'private',
    assetCount: 100,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'lib-2',
    userId: 'user-1',
    name: 'Work Events',
    description: 'Company events',
    visibility: 'shared',
    assetCount: 50,
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  },
];

// Mock hook implementations
const mockUseAllMedia = {
  media: mockMediaList,
  isLoading: false,
  isLoadingMore: false,
  error: null,
  hasMore: false,
  total: mockMediaList.length,
  loadMore: vi.fn(),
  refresh: vi.fn(),
};

const mockUseLibraries = {
  libraries: mockLibraries,
  isLoading: false,
  error: null,
  createLibrary: vi.fn(),
  updateLibrary: vi.fn(),
  deleteLibrary: vi.fn(),
};

describe('AllMediaPage - Integration Tests', () => {
  beforeEach(() => {
    // Setup hooks
    vi.mocked(await import('../../hooks/useAllMedia')).useAllMedia = vi.fn(() => mockUseAllMedia);
    vi.mocked(await import('../../hooks/useLibraries')).useLibraries = vi.fn(() => mockUseLibraries);

    // Reset API mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('bulk selection workflow', () => {
    it('allows selecting multiple items and shows toolbar', () => {
      render(<AllMediaPage />);

      // Initially no toolbar
      expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();

      // Select first item
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);

      // Toolbar should appear
      expect(screen.getByText('1 selected')).toBeInTheDocument();

      // Select second item
      fireEvent.click(checkboxes[1]);

      // Count should update
      expect(screen.getByText('2 selected')).toBeInTheDocument();
    });

    it('clears selection when close button is clicked', () => {
      render(<AllMediaPage />);

      // Select items
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);

      expect(screen.getByText('2 selected')).toBeInTheDocument();

      // Click close button on toolbar
      const closeButton = screen.getByTestId('CloseIcon').closest('button') as HTMLElement;
      fireEvent.click(closeButton);

      // Toolbar should disappear
      expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
    });

    it('maintains selection when items are toggled on and off', () => {
      render(<AllMediaPage />);

      const checkboxes = screen.getAllByRole('checkbox');

      // Select 3 items
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);
      fireEvent.click(checkboxes[2]);

      expect(screen.getByText('3 selected')).toBeInTheDocument();

      // Deselect middle item
      fireEvent.click(checkboxes[1]);

      expect(screen.getByText('2 selected')).toBeInTheDocument();

      // Reselect it
      fireEvent.click(checkboxes[1]);

      expect(screen.getByText('3 selected')).toBeInTheDocument();
    });
  });

  describe('add to library workflow', () => {
    it('opens add to library dialog when button is clicked', async () => {
      render(<AllMediaPage />);

      // Select items
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);

      // Click Add to Library button
      const addButton = screen.getByText('Add to Library');
      fireEvent.click(addButton);

      // Dialog should open
      await waitFor(() => {
        expect(screen.getByText(/Add 2 selected items to a library/i)).toBeInTheDocument();
      });
    });

    it('successfully adds items to library', async () => {
      // Mock successful API call
      vi.mocked(libraryApi.addAssets).mockResolvedValue([]);

      render(<AllMediaPage />);

      // Select items
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);

      // Open dialog
      const addButton = screen.getByText('Add to Library');
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
      const dialogAddButton = screen.getAllByText('Add to Library').find((el) => el.tagName === 'BUTTON');
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

      render(<AllMediaPage />);

      // Select items
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);

      // Open dialog and select library
      const addButton = screen.getByText('Add to Library');
      fireEvent.click(addButton);

      await waitFor(() => {
        const select = screen.getByLabelText(/Select Library/i);
        fireEvent.mouseDown(select);

        const libraryOption = screen.getByText('Family Photos');
        fireEvent.click(libraryOption);

        const dialogAddButton = screen.getAllByText('Add to Library').find((el) => el.tagName === 'BUTTON');
        fireEvent.click(dialogAddButton!);
      });

      // Error message should appear
      await waitFor(() => {
        expect(screen.getByText(/Failed to add to library/i)).toBeInTheDocument();
      });
    });
  });

  describe('edit metadata workflow', () => {
    it('opens metadata dialog when button is clicked', async () => {
      render(<AllMediaPage />);

      // Select items
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);
      fireEvent.click(checkboxes[2]);

      // Click Edit Metadata button
      const editButton = screen.getByText('Edit Metadata');
      fireEvent.click(editButton);

      // Dialog should open
      await waitFor(() => {
        expect(screen.getByText(/Edit Metadata/i)).toBeInTheDocument();
        expect(screen.getByText(/3 selected items/i)).toBeInTheDocument();
      });
    });

    it('successfully updates metadata', async () => {
      // Mock successful API call
      vi.mocked(mediaApi.bulkUpdateMetadata).mockResolvedValue({
        updated: ['asset-1', 'asset-2'],
        failed: [],
      });

      render(<AllMediaPage />);

      // Select items
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);

      // Open dialog
      const editButton = screen.getByText('Edit Metadata');
      fireEvent.click(editButton);

      await waitFor(() => {
        expect(screen.getByText(/Edit Metadata/i)).toBeInTheDocument();
      });

      // Enable country field and set value
      const countryCheckbox = screen.getAllByRole('checkbox').find((cb) => {
        const label = cb.closest('div')?.textContent;
        return label?.includes('Country');
      });
      fireEvent.click(countryCheckbox!);

      const countryInput = screen.getByLabelText(/Country/i);
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

      render(<AllMediaPage />);

      // Select 3 items
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);
      fireEvent.click(checkboxes[2]);

      // Open dialog, enable field, set value, apply
      const editButton = screen.getByText('Edit Metadata');
      fireEvent.click(editButton);

      await waitFor(async () => {
        const countryCheckbox = screen.getAllByRole('checkbox').find((cb) => {
          return cb.closest('div')?.textContent?.includes('Country');
        });
        fireEvent.click(countryCheckbox!);

        const countryInput = screen.getByLabelText(/Country/i);
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
      render(<AllMediaPage />);

      // Select items
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);

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

      render(<AllMediaPage />);

      // Select items
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);
      fireEvent.click(checkboxes[2]);

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
      render(<AllMediaPage />);

      // Select items
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);

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

      render(<AllMediaPage />);

      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);

      const editButton = screen.getByText('Edit Metadata');
      fireEvent.click(editButton);

      await waitFor(async () => {
        const countryCheckbox = screen.getAllByRole('checkbox').find((cb) => {
          return cb.closest('div')?.textContent?.includes('Country');
        });
        fireEvent.click(countryCheckbox!);

        const countryInput = screen.getByLabelText(/Country/i);
        fireEvent.change(countryInput, { target: { value: 'USA' } });

        const applyButton = screen.getByText(/Apply to 1 Item/i);
        fireEvent.click(applyButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/Failed to update metadata/i)).toBeInTheDocument();
      });
    });

    it('refreshes media after successful operations', async () => {
      vi.mocked(libraryApi.addAssets).mockResolvedValue([]);

      render(<AllMediaPage />);

      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);

      const addButton = screen.getByText('Add to Library');
      fireEvent.click(addButton);

      await waitFor(() => {
        const select = screen.getByLabelText(/Select Library/i);
        fireEvent.mouseDown(select);

        const libraryOption = screen.getByText('Family Photos');
        fireEvent.click(libraryOption);

        const dialogAddButton = screen.getAllByText('Add to Library').find((el) => el.tagName === 'BUTTON');
        fireEvent.click(dialogAddButton!);
      });

      // Refresh should be called
      await waitFor(() => {
        expect(mockUseAllMedia.refresh).toHaveBeenCalled();
      });
    });
  });

  describe('edge cases', () => {
    it('handles empty media list', () => {
      vi.mocked(await import('../../hooks/useAllMedia')).useAllMedia = vi.fn(() => ({
        ...mockUseAllMedia,
        media: [],
        total: 0,
      }));

      render(<AllMediaPage />);

      expect(screen.getByText(/No media found/i)).toBeInTheDocument();
      expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();
    });

    it('handles loading state', () => {
      vi.mocked(await import('../../hooks/useAllMedia')).useAllMedia = vi.fn(() => ({
        ...mockUseAllMedia,
        isLoading: true,
        media: [],
      }));

      render(<AllMediaPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('handles no libraries available', async () => {
      vi.mocked(await import('../../hooks/useLibraries')).useLibraries = vi.fn(() => ({
        ...mockUseLibraries,
        libraries: [],
      }));

      render(<AllMediaPage />);

      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);

      const addButton = screen.getByText('Add to Library');
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByText(/You don't have any libraries/i)).toBeInTheDocument();
      });
    });
  });
});

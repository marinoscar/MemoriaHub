import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { LibraryGalleryPage } from './LibraryGalleryPage';
import { createMockLibrary, createMockMedia } from '../test/test-helpers';
import type { MediaAssetDTO, LibraryDTO } from '@memoriahub/shared';

// Mock hooks
const mockRefreshMedia = vi.fn();
const mockUseLibrary = vi.fn();
const mockUseMedia = vi.fn();
const mockUseMediaSelection = vi.fn();
const mockUseLibraries = vi.fn();
const mockAddAssets = vi.fn();

vi.mock('../hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks')>();
  return {
    ...actual,
    useLibrary: () => mockUseLibrary(),
    useMedia: () => mockUseMedia(),
    useMediaSelection: () => mockUseMediaSelection(),
    useLibraries: () => mockUseLibraries(),
  };
});

vi.mock('../services/api/library.api', () => ({
  libraryApi: {
    addAssets: (...args: unknown[]) => mockAddAssets(...args),
  },
}));

vi.mock('../services/api/media.api', () => ({
  mediaApi: {
    bulkUpdateMetadata: vi.fn(),
    bulkDelete: vi.fn(),
  },
}));

// Mock the useAllMedia hook used by AddExistingMediaDialog
const mockUseAllMedia = vi.fn();
vi.mock('../hooks/useAllMedia', () => ({
  useAllMedia: () => mockUseAllMedia(),
}));

// Mock data
const mockLibrary: LibraryDTO = createMockLibrary('lib-1', 'Family Photos', {
  description: 'Our family memories',
  visibility: 'private',
  assetCount: 10,
});

const mockMedia: MediaAssetDTO[] = [
  createMockMedia('media-1', { originalFilename: 'photo1.jpg' }),
  createMockMedia('media-2', { originalFilename: 'photo2.jpg' }),
];

const mockAllMedia: MediaAssetDTO[] = [
  createMockMedia('media-1', { originalFilename: 'photo1.jpg' }),
  createMockMedia('media-2', { originalFilename: 'photo2.jpg' }),
  createMockMedia('media-3', { originalFilename: 'photo3.jpg' }),
  createMockMedia('media-4', { originalFilename: 'photo4.jpg' }),
];

const mockLibraries: LibraryDTO[] = [
  mockLibrary,
  createMockLibrary('lib-2', 'Work Events', { visibility: 'shared' }),
];

const renderWithRouter = (libraryId = 'lib-1') => {
  return render(
    <MemoryRouter initialEntries={[`/libraries/${libraryId}`]}>
      <Routes>
        <Route path="/libraries/:libraryId" element={<LibraryGalleryPage />} />
        <Route path="/libraries" element={<div>Libraries List</div>} />
      </Routes>
    </MemoryRouter>
  );
};

describe('LibraryGalleryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseLibrary.mockReturnValue({
      library: mockLibrary,
      isLoading: false,
      error: null,
    });

    mockUseMedia.mockReturnValue({
      media: mockMedia,
      isLoading: false,
      isLoadingMore: false,
      error: null,
      hasMore: false,
      loadMore: vi.fn(),
      refresh: mockRefreshMedia,
    });

    mockUseMediaSelection.mockReturnValue({
      selectedIds: new Set<string>(),
      toggleSelection: vi.fn(),
      clearSelection: vi.fn(),
      selectedCount: 0,
    });

    mockUseLibraries.mockReturnValue({
      libraries: mockLibraries,
      isLoading: false,
      error: null,
    });

    mockUseAllMedia.mockReturnValue({
      media: mockAllMedia,
      isLoading: false,
      isLoadingMore: false,
      hasMore: false,
      loadMore: vi.fn(),
      error: null,
    });

    mockAddAssets.mockResolvedValue({ added: ['media-3', 'media-4'] });
  });

  describe('rendering', () => {
    it('renders library name and details', () => {
      renderWithRouter();

      // Library name appears in breadcrumb and heading, use getAllBy
      expect(screen.getAllByText('Family Photos').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Our family memories')).toBeInTheDocument();
      expect(screen.getByText('10 items')).toBeInTheDocument();
    });

    it('renders Upload button', () => {
      renderWithRouter();

      expect(screen.getByRole('button', { name: /Upload/i })).toBeInTheDocument();
    });

    it('renders Add Existing button', () => {
      renderWithRouter();

      expect(screen.getByRole('button', { name: /Add Existing/i })).toBeInTheDocument();
    });

    it('renders breadcrumbs', () => {
      renderWithRouter();

      expect(screen.getByText('Libraries')).toBeInTheDocument();
    });

    it('shows visibility chip', () => {
      renderWithRouter();

      expect(screen.getByText('Private')).toBeInTheDocument();
    });
  });

  describe('loading state', () => {
    it('shows loading spinner when library is loading', () => {
      mockUseLibrary.mockReturnValue({
        library: null,
        isLoading: true,
        error: null,
      });

      renderWithRouter();

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows error message when library fails to load', () => {
      mockUseLibrary.mockReturnValue({
        library: null,
        isLoading: false,
        error: 'Library not found',
      });

      renderWithRouter();

      expect(screen.getByText('Library not found')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Back to Libraries/i })).toBeInTheDocument();
    });
  });

  describe('Add Existing Media functionality', () => {
    it('opens Add Existing Media dialog when button is clicked', () => {
      renderWithRouter();

      const addExistingButton = screen.getByRole('button', { name: /Add Existing/i });
      fireEvent.click(addExistingButton);

      expect(screen.getByText('Add Existing Media')).toBeInTheDocument();
      expect(screen.getByText(/Select media to add to "Family Photos"/)).toBeInTheDocument();
    });

    it('closes dialog when Cancel is clicked', async () => {
      renderWithRouter();

      // Open dialog
      const addExistingButton = screen.getByRole('button', { name: /Add Existing/i });
      fireEvent.click(addExistingButton);

      expect(screen.getByText('Add Existing Media')).toBeInTheDocument();

      // Close dialog
      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);

      // Dialog close calls onClose which updates state - animation may delay removal
      // Just verify onClose behavior was triggered (dialog internal state reset)
      await waitFor(() => {
        // After clicking Cancel, the dialog should eventually close
        // Due to MUI animations, we check for the dialog heading disappearing
        expect(screen.queryByText('Add Existing Media')).not.toBeInTheDocument();
      }, { timeout: 3000 });
    });

    it('calls libraryApi.addAssets when media is added', async () => {
      renderWithRouter();

      // Open dialog
      const addExistingButton = screen.getByRole('button', { name: /Add Existing/i });
      fireEvent.click(addExistingButton);

      // Select media by clicking on a media card
      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]); // Select first available media

      // Click add button
      const addButton = screen.getByRole('button', { name: /to Library/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(mockAddAssets).toHaveBeenCalledTimes(1);
        expect(mockAddAssets).toHaveBeenCalledWith('lib-1', expect.any(Array));
      });
    });

    it('shows success snackbar after adding media', async () => {
      renderWithRouter();

      // Open dialog
      const addExistingButton = screen.getByRole('button', { name: /Add Existing/i });
      fireEvent.click(addExistingButton);

      // Select media by clicking on a media card
      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]);

      // Click add button
      const addButton = screen.getByRole('button', { name: /to Library/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByText(/Added.*items to library/i)).toBeInTheDocument();
      });
    });

    it('refreshes media list after adding', async () => {
      renderWithRouter();

      // Open dialog
      const addExistingButton = screen.getByRole('button', { name: /Add Existing/i });
      fireEvent.click(addExistingButton);

      // Select and add media by clicking on a media card
      const mediaCards = screen.getAllByRole('button', { name: /View photo/i });
      fireEvent.click(mediaCards[0]);

      const addButton = screen.getByRole('button', { name: /to Library/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(mockRefreshMedia).toHaveBeenCalled();
      });
    });

    it('filters out media already in the library', () => {
      renderWithRouter();

      // Open dialog
      const addExistingButton = screen.getByRole('button', { name: /Add Existing/i });
      fireEvent.click(addExistingButton);

      // mockMedia has media-1 and media-2 (already in library)
      // mockAllMedia has media-1, media-2, media-3, media-4
      // So only media-3 and media-4 should be available (2 items)
      expect(screen.getByText('2 available')).toBeInTheDocument();
    });
  });

  describe('Upload dialog', () => {
    it('opens Upload dialog when Upload button is clicked', () => {
      renderWithRouter();

      const uploadButton = screen.getByRole('button', { name: /Upload/i });
      fireEvent.click(uploadButton);

      // UploadDialog should be rendered (checking for dialog presence)
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('navigation', () => {
    it('navigates back to libraries when breadcrumb is clicked', () => {
      renderWithRouter();

      const librariesLink = screen.getByText('Libraries');
      fireEvent.click(librariesLink);

      expect(screen.getByText('Libraries List')).toBeInTheDocument();
    });
  });

  describe('media grid', () => {
    it('renders media items', () => {
      renderWithRouter();

      // Media items should be rendered
      const images = screen.getAllByRole('img');
      expect(images.length).toBeGreaterThanOrEqual(2);
    });
  });
});

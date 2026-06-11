/**
 * Component tests — MediaLibraryPage
 *
 * Mocking strategy (mirrors UserManagementPage.test.tsx pattern):
 *   - useMedia and useAlbums hooks are module-mocked via vi.mock so no real API
 *     calls are made.
 *   - listTags (services/media) is mocked to return an empty array by default.
 *   - MediaDetailDrawer and MediaUploadDialog are rendered normally; their
 *     internal service calls are mocked at the service level (services/media).
 *   - The test suite verifies: grid renders items, grouping headers appear,
 *     applying a filter triggers fetchMedia with the expected param, and
 *     clicking a tile opens the drawer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';
import MediaLibraryPage from '../../pages/MediaLibrary/MediaLibraryPage';
import type { MediaItem, MediaListMeta } from '../../types/media';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useMedia', () => ({
  useMedia: vi.fn(),
}));

vi.mock('../../hooks/useAlbums', () => ({
  useAlbums: vi.fn(),
}));

vi.mock('../../services/media', () => ({
  listTags: vi.fn(),
  patchMedia: vi.fn(),
  initUpload: vi.fn(),
  uploadPart: vi.fn(),
  completeUpload: vi.fn(),
  registerMedia: vi.fn(),
  listAlbums: vi.fn(),
}));

import { useMedia } from '../../hooks/useMedia';
import { useAlbums } from '../../hooks/useAlbums';
import { listTags, patchMedia } from '../../services/media';

const mockUseMedia = vi.mocked(useMedia);
const mockUseAlbums = vi.mocked(useAlbums);
const mockListTags = vi.mocked(listTags);
const mockPatchMedia = vi.mocked(patchMedia);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const defaultMeta: MediaListMeta = {
  page: 1,
  pageSize: 20,
  totalItems: 0,
  totalPages: 1,
};

function makeMediaItem(id: string, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    storageObjectId: `storage-${id}`,
    ownerId: 'user-001',
    type: 'photo',
    capturedAt: '2024-06-15T10:30:00.000Z',
    capturedAtOffset: null,
    importedAt: null,
    source: 'web',
    contentHash: null,
    classification: 'unreviewed',
    width: 1920,
    height: 1080,
    durationMs: null,
    orientation: null,
    takenLat: null,
    takenLng: null,
    takenAltitude: null,
    cameraMake: null,
    cameraModel: null,
    originalFilename: `file-${id}.jpg`,
    title: `Media ${id}`,
    caption: null,
    description: null,
    favorite: false,
    geoCountry: null,
    geoCountryCode: null,
    geoAdmin1: null,
    geoAdmin2: null,
    geoLocality: null,
    geoPlaceName: null,
    geoSource: null,
    geocodedAt: null,
    createdAt: '2024-06-15T10:30:00.000Z',
    updatedAt: '2024-06-15T10:30:00.000Z',
    deletedAt: null,
    metadata: null,
    thumbnailUrl: null,
    downloadUrl: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Default hook implementations
// ---------------------------------------------------------------------------

function makeUseMediaDefaults(items: MediaItem[] = [], overrides: Record<string, unknown> = {}) {
  const fetchMedia = vi.fn().mockResolvedValue(undefined);
  const patchMediaHook = vi.fn().mockResolvedValue(undefined);
  const updateItemLocally = vi.fn();
  return {
    items,
    meta: { ...defaultMeta, totalItems: items.length },
    isLoading: false,
    error: null,
    filters: {},
    setFilters: vi.fn(),
    fetchMedia,
    patchMedia: patchMediaHook,
    removeMedia: vi.fn(),
    updateItemLocally,
    ...overrides,
  };
}

function makeUseAlbumsDefaults() {
  return {
    albums: [],
    meta: null,
    isLoading: false,
    error: null,
    fetchAlbums: vi.fn().mockResolvedValue(undefined),
    addAlbum: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaLibraryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMedia.mockReturnValue(makeUseMediaDefaults());
    mockUseAlbums.mockReturnValue(makeUseAlbumsDefaults());
    mockListTags.mockResolvedValue([]);
    mockPatchMedia.mockResolvedValue(makeMediaItem('media-001'));
  });

  // -------------------------------------------------------------------------
  // Page header
  // -------------------------------------------------------------------------

  describe('page header', () => {
    it('should render the "Media Library" heading', () => {
      render(<MediaLibraryPage />);
      expect(
        screen.getByRole('heading', { name: /media library/i }),
      ).toBeInTheDocument();
    });

    it('should render the Filters toggle button', () => {
      render(<MediaLibraryPage />);
      expect(screen.getByRole('button', { name: /filters/i })).toBeInTheDocument();
    });

    it('should render the Upload FAB', () => {
      render(<MediaLibraryPage />);
      // Multiple "Upload media" labelled buttons can exist (FAB + empty-state CTA)
      expect(
        screen.getAllByRole('button', { name: /upload media/i }).length,
      ).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  describe('loading state', () => {
    it('should show a loading spinner while isLoading is true', () => {
      mockUseMedia.mockReturnValue(makeUseMediaDefaults([], { isLoading: true }));
      render(<MediaLibraryPage />);
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  describe('empty state', () => {
    it('should show "No media found" when items list is empty and not loading', () => {
      render(<MediaLibraryPage />);
      expect(screen.getByText(/no media found/i)).toBeInTheDocument();
    });

    it('should show an Upload Media CTA in empty state', () => {
      render(<MediaLibraryPage />);
      // The "Upload Media" button in empty-state body + the FAB both have this label
      const uploadBtns = screen.getAllByRole('button', { name: /upload media/i });
      expect(uploadBtns.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Grid — renders items
  // -------------------------------------------------------------------------

  describe('grid rendering', () => {
    it('should render an image tile for each media item with a thumbnail URL', () => {
      // When thumbnailUrl is set the tile renders an <img> element.
      // When it's null, a placeholder icon is shown instead (no img).
      const items = [
        makeMediaItem('a', { title: 'Photo A', thumbnailUrl: 'http://cdn/a.jpg' }),
        makeMediaItem('b', { title: 'Photo B', thumbnailUrl: 'http://cdn/b.jpg' }),
        makeMediaItem('c', { title: 'Photo C', thumbnailUrl: 'http://cdn/c.jpg' }),
      ];
      mockUseMedia.mockReturnValue(makeUseMediaDefaults(items));
      render(<MediaLibraryPage />);
      expect(screen.getByAltText('Photo A')).toBeInTheDocument();
      expect(screen.getByAltText('Photo B')).toBeInTheDocument();
      expect(screen.getByAltText('Photo C')).toBeInTheDocument();
    });

    it('should render placeholder icons when thumbnailUrl is null', () => {
      const items = [
        makeMediaItem('p1', { title: 'No Thumb', thumbnailUrl: null }),
      ];
      mockUseMedia.mockReturnValue(makeUseMediaDefaults(items));
      render(<MediaLibraryPage />);
      // No img alt text; placeholder icon is present
      expect(screen.queryByAltText('No Thumb')).not.toBeInTheDocument();
    });

    it('should not render empty-state text when items exist', () => {
      const items = [makeMediaItem('x', { title: 'Any Photo' })];
      mockUseMedia.mockReturnValue(makeUseMediaDefaults(items));
      render(<MediaLibraryPage />);
      expect(screen.queryByText(/no media found/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Grouping headers by capturedAt month
  // -------------------------------------------------------------------------

  describe('grouping by month', () => {
    it('should render a month group header for June 2024 items', () => {
      const items = [makeMediaItem('g1', { capturedAt: '2024-06-10T12:00:00.000Z' })];
      mockUseMedia.mockReturnValue(makeUseMediaDefaults(items));
      render(<MediaLibraryPage />);
      expect(screen.getByText(/june 2024/i)).toBeInTheDocument();
    });

    it('should render separate group headers for items in different months', () => {
      const items = [
        makeMediaItem('m1', { capturedAt: '2024-06-01T00:00:00.000Z' }),
        makeMediaItem('m2', { capturedAt: '2024-05-15T00:00:00.000Z' }),
      ];
      mockUseMedia.mockReturnValue(makeUseMediaDefaults(items));
      render(<MediaLibraryPage />);
      expect(screen.getByText(/june 2024/i)).toBeInTheDocument();
      expect(screen.getByText(/may 2024/i)).toBeInTheDocument();
    });

    it('should render an "Unknown Date" group for items with null capturedAt', () => {
      const items = [makeMediaItem('u1', { capturedAt: null })];
      mockUseMedia.mockReturnValue(makeUseMediaDefaults(items));
      render(<MediaLibraryPage />);
      expect(screen.getByText(/unknown date/i)).toBeInTheDocument();
    });

    it('should sort newest month first', () => {
      const items = [
        makeMediaItem('old', { capturedAt: '2023-01-01T00:00:00.000Z' }),
        makeMediaItem('new', { capturedAt: '2024-12-01T00:00:00.000Z' }),
      ];
      mockUseMedia.mockReturnValue(makeUseMediaDefaults(items));
      render(<MediaLibraryPage />);
      const headers = screen.getAllByText(/\d{4}/);
      // The first header in the DOM should contain 2024 (newest)
      expect(headers[0].textContent).toMatch(/2024/);
    });
  });

  // -------------------------------------------------------------------------
  // Filter interaction — favourite
  // -------------------------------------------------------------------------

  describe('filter — favorites', () => {
    it('should call fetchMedia with favorite:true after toggling favorites filter', async () => {
      const fetchMedia = vi.fn().mockResolvedValue(undefined);
      mockUseMedia.mockReturnValue(makeUseMediaDefaults([], { fetchMedia }));
      const user = userEvent.setup();
      render(<MediaLibraryPage />);

      // Open filter panel
      await user.click(screen.getByRole('button', { name: /filters/i }));

      // Click the "Favorites only" toggle button
      const favoritesBtn = await screen.findByRole('button', { name: /favorites only/i });
      await user.click(favoritesBtn);

      await waitFor(() => {
        expect(fetchMedia).toHaveBeenCalledWith(
          expect.objectContaining({ favorite: true }),
        );
      });
    });

    it('should call fetchMedia without favorite param after toggling back to All', async () => {
      const fetchMedia = vi.fn().mockResolvedValue(undefined);
      mockUseMedia.mockReturnValue(makeUseMediaDefaults([], { fetchMedia }));
      const user = userEvent.setup();
      render(<MediaLibraryPage />);

      await user.click(screen.getByRole('button', { name: /filters/i }));
      const favoritesBtn = await screen.findByRole('button', { name: /favorites only/i });
      await user.click(favoritesBtn); // enable
      await user.click(screen.getByRole('button', { name: /^all$/i })); // back to all

      await waitFor(() => {
        // The last call should not include favorite: true
        const calls = fetchMedia.mock.calls;
        const lastCall = calls[calls.length - 1][0];
        expect(lastCall.favorite).toBeFalsy();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Filter interaction — location search
  // -------------------------------------------------------------------------

  describe('filter — location search', () => {
    it('should call fetchMedia with location param after typing in the search box', async () => {
      const fetchMedia = vi.fn().mockResolvedValue(undefined);
      mockUseMedia.mockReturnValue(makeUseMediaDefaults([], { fetchMedia }));
      const user = userEvent.setup();
      render(<MediaLibraryPage />);

      // Open filters
      await user.click(screen.getByRole('button', { name: /filters/i }));

      const locationInput = await screen.findByPlaceholderText(/california.*costa rica.*yosemite/i);
      await user.type(locationInput, 'Paris');

      await waitFor(() => {
        const calls = fetchMedia.mock.calls;
        const matchingCall = calls.find(
          ([params]) => typeof params.location === 'string' && params.location.includes('Paris'),
        );
        expect(matchingCall).toBeDefined();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Drawer — clicking a tile opens the detail drawer
  // -------------------------------------------------------------------------

  describe('detail drawer', () => {
    it('should open the detail drawer when an image tile is clicked', async () => {
      const user = userEvent.setup();
      const items = [
        makeMediaItem('click-me', {
          title: 'Click Target',
          thumbnailUrl: 'http://cdn/click-me.jpg',
        }),
      ];
      mockUseMedia.mockReturnValue(makeUseMediaDefaults(items));
      render(<MediaLibraryPage />);

      // The tile renders an <img> when thumbnailUrl is set
      const tileImg = screen.getByAltText('Click Target');
      await user.click(tileImg);

      await waitFor(() => {
        // The drawer renders the item title in its header — now more than one
        // occurrence of the text is visible (tile + drawer header)
        expect(screen.getAllByText('Click Target').length).toBeGreaterThan(1);
      });
    });

    it('should render the detail drawer in the closed state initially', () => {
      const items = [makeMediaItem('d1', { title: 'Drawer Test' })];
      mockUseMedia.mockReturnValue(makeUseMediaDefaults(items));
      render(<MediaLibraryPage />);
      // The close-detail-panel button should not be visible before tile click
      expect(
        screen.queryByRole('button', { name: /close detail panel/i }),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------

  describe('error state', () => {
    it('should display an error alert when the hook reports an error', () => {
      mockUseMedia.mockReturnValue(
        makeUseMediaDefaults([], { error: 'Failed to load media' }),
      );
      render(<MediaLibraryPage />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/failed to load media/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Mount / unmount
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('should call fetchMedia on mount', () => {
      const fetchMedia = vi.fn().mockResolvedValue(undefined);
      mockUseMedia.mockReturnValue(makeUseMediaDefaults([], { fetchMedia }));
      render(<MediaLibraryPage />);
      expect(fetchMedia).toHaveBeenCalledTimes(1);
    });

    it('should call fetchAlbums on mount', () => {
      const fetchAlbums = vi.fn().mockResolvedValue(undefined);
      mockUseAlbums.mockReturnValue({ ...makeUseAlbumsDefaults(), fetchAlbums });
      render(<MediaLibraryPage />);
      expect(fetchAlbums).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Component tests — MediaLibraryPage
 *
 * Post-refactor architecture: the page itself no longer renders the grid,
 * month grouping, tiles, pagination, selection mode, or the detail drawer —
 * all of that now lives in the shared <MediaGallery> component (feed mode),
 * which has its own dedicated test suite at
 * apps/web/src/components/media/__tests__/MediaGallery.test.tsx.
 *
 * This page's remaining responsibilities are:
 *   - Rendering the header, Export button, and Filters toggle/panel.
 *   - Building `queryParams` from filter state (type, album, sort, date
 *     range, favorites, camera/device, missing-geo/faces, location
 *     drill-down, people, tags) and passing them to <MediaGallery
 *     queryParams=... mode="home" />.
 *   - Using `useMedia` ONLY to sample items (page 1, pageSize 200) for the
 *     location facet (country/region/city) pick-lists — not for rendering
 *     a visible grid.
 *
 * Mocking strategy:
 *   - useMedia, useAlbums, useCircle are module-mocked via vi.mock so no
 *     real API calls are made.
 *   - listTags / exportMedia (services/media) are mocked.
 *   - <MediaGallery> is mocked to a lightweight stub that stashes the
 *     `queryParams` prop it received as a `data-query-params` JSON
 *     attribute, so tests can assert filter state flows through correctly
 *     without needing to drive MediaGallery's internal infinite-scroll
 *     fetching.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';
import MediaLibraryPage from '../../pages/MediaLibrary/MediaLibraryPage';
import type { MediaItem, MediaListMeta, Album } from '../../types/media';
import type { MediaGalleryProps } from '../../components/media/MediaGallery';

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
  exportMedia: vi.fn(),
}));

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../components/media/MediaGallery', () => ({
  MediaGallery: (props: MediaGalleryProps) => (
    <div
      data-testid="media-gallery"
      data-query-params={JSON.stringify(props.queryParams ?? {})}
      data-mode={props.mode}
      data-circle-id={props.circleId}
      data-circle-role={props.activeCircleRole ?? ''}
    />
  ),
}));

import { useMedia } from '../../hooks/useMedia';
import { useAlbums } from '../../hooks/useAlbums';
import { listTags } from '../../services/media';
import { useCircle } from '../../hooks/useCircle';

const mockUseMedia = vi.mocked(useMedia);
const mockUseAlbums = vi.mocked(useAlbums);
const mockListTags = vi.mocked(listTags);
const mockUseCircle = vi.mocked(useCircle);

const mockActiveCircle = {
  id: 'circle-1',
  name: "Test User's Library",
  description: null,
  ownerId: 'test-user-id',
  isPersonal: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeUseCircleDefaults(overrides: Record<string, unknown> = {}) {
  return {
    circles: [mockActiveCircle],
    activeCircle: mockActiveCircle,
    activeCircleId: 'circle-1',
    activeCircleRole: 'circle_admin' as const,
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

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
    addedById: 'user-001',
    circleId: 'circle-1',
    type: 'photo',
    capturedAt: '2024-06-15T10:30:00.000Z',
    capturedAtOffset: null,
    importedAt: null,
    source: 'web',
    contentHash: null,
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

function makeAlbum(id: string, overrides: Partial<Album> = {}): Album {
  return {
    id,
    name: `Album ${id}`,
    description: null,
    addedById: 'user-001',
    circleId: 'circle-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Default hook implementations
// ---------------------------------------------------------------------------

function makeUseMediaDefaults(items: MediaItem[] = [], overrides: Record<string, unknown> = {}) {
  const fetchMedia = vi.fn().mockResolvedValue(items);
  return {
    items,
    meta: { ...defaultMeta, totalItems: items.length },
    isLoading: false,
    error: null,
    filters: {},
    setFilters: vi.fn(),
    fetchMedia,
    patchMedia: vi.fn().mockResolvedValue(undefined),
    removeMedia: vi.fn(),
    updateItemLocally: vi.fn(),
    ...overrides,
  };
}

function makeUseAlbumsDefaults(albums: Album[] = []) {
  return {
    albums,
    meta: null,
    isLoading: false,
    error: null,
    fetchAlbums: vi.fn().mockResolvedValue(undefined),
    addAlbum: vi.fn(),
    updateAlbum: vi.fn(),
    deleteAlbum: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Read the queryParams the page most recently passed to <MediaGallery>. */
function getGalleryQueryParams(): Record<string, unknown> {
  const el = screen.getByTestId('media-gallery');
  return JSON.parse(el.getAttribute('data-query-params') ?? '{}');
}

async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /filters/i }));
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
    mockUseCircle.mockReturnValue(makeUseCircleDefaults());
  });

  // -------------------------------------------------------------------------
  // Page header / chrome
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

    it('should render the Export button', () => {
      render(<MediaLibraryPage />);
      expect(
        screen.getByRole('button', { name: /export media metadata/i }),
      ).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // MediaGallery delegation
  // -------------------------------------------------------------------------

  describe('MediaGallery delegation', () => {
    it('renders MediaGallery in "home" mode scoped to the active circle', () => {
      render(<MediaLibraryPage />);
      const gallery = screen.getByTestId('media-gallery');
      expect(gallery).toHaveAttribute('data-mode', 'home');
      expect(gallery).toHaveAttribute('data-circle-id', 'circle-1');
      expect(gallery).toHaveAttribute('data-circle-role', 'circle_admin');
    });

    it('passes circleId in the initial queryParams', () => {
      render(<MediaLibraryPage />);
      expect(getGalleryQueryParams()).toEqual(
        expect.objectContaining({ circleId: 'circle-1' }),
      );
    });

    it('passes default sort params (capturedAt desc) with no filters applied', () => {
      render(<MediaLibraryPage />);
      expect(getGalleryQueryParams()).toEqual(
        expect.objectContaining({ sortBy: 'capturedAt', sortOrder: 'desc' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Circle scoping
  // -------------------------------------------------------------------------

  describe('circle scoping', () => {
    it('should show "Select a circle" message when no active circle', () => {
      mockUseCircle.mockReturnValue(makeUseCircleDefaults({ activeCircle: null }));
      render(<MediaLibraryPage />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/select a circle/i)).toBeInTheDocument();
    });

    it('should not render MediaGallery when no active circle', () => {
      mockUseCircle.mockReturnValue(makeUseCircleDefaults({ activeCircle: null }));
      render(<MediaLibraryPage />);
      expect(screen.queryByTestId('media-gallery')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle — facet sample fetch + album fetch
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('should call fetchMedia (facet sample) on mount', () => {
      const fetchMedia = vi.fn().mockResolvedValue([]);
      mockUseMedia.mockReturnValue(makeUseMediaDefaults([], { fetchMedia }));
      render(<MediaLibraryPage />);
      expect(fetchMedia).toHaveBeenCalledTimes(1);
    });

    it('should call fetchMedia with a large pageSize sample for facet derivation', () => {
      const fetchMedia = vi.fn().mockResolvedValue([]);
      mockUseMedia.mockReturnValue(makeUseMediaDefaults([], { fetchMedia }));
      render(<MediaLibraryPage />);
      expect(fetchMedia).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, pageSize: 200, circleId: 'circle-1' }),
      );
    });

    it('should call fetchAlbums on mount', () => {
      const fetchAlbums = vi.fn().mockResolvedValue(undefined);
      mockUseAlbums.mockReturnValue({ ...makeUseAlbumsDefaults(), fetchAlbums });
      render(<MediaLibraryPage />);
      expect(fetchAlbums).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Filter — type
  // -------------------------------------------------------------------------

  describe('filter — type', () => {
    it('should include type:"video" in queryParams after selecting Videos', async () => {
      const user = userEvent.setup();
      render(<MediaLibraryPage />);

      await openFilters(user);

      const comboboxes = screen.getAllByRole('combobox');
      fireEvent.mouseDown(comboboxes[0]); // Type select
      await user.click(screen.getByRole('option', { name: /^videos$/i }));

      await waitFor(() => {
        expect(getGalleryQueryParams()).toEqual(
          expect.objectContaining({ type: 'video' }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Filter — album
  // -------------------------------------------------------------------------

  describe('filter — album', () => {
    it('should include albumId in queryParams after selecting an album', async () => {
      const album = makeAlbum('album-1', { name: 'Summer Trip' });
      mockUseAlbums.mockReturnValue(makeUseAlbumsDefaults([album]));
      const user = userEvent.setup();
      render(<MediaLibraryPage />);

      await openFilters(user);

      const comboboxes = screen.getAllByRole('combobox');
      fireEvent.mouseDown(comboboxes[1]); // Album select
      await user.click(screen.getByRole('option', { name: /summer trip/i }));

      await waitFor(() => {
        expect(getGalleryQueryParams()).toEqual(
          expect.objectContaining({ albumId: 'album-1' }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Filter — sort
  // -------------------------------------------------------------------------

  describe('filter — sort', () => {
    it('should update sortBy/sortOrder in queryParams after selecting "Imported — Newest"', async () => {
      const user = userEvent.setup();
      render(<MediaLibraryPage />);

      await openFilters(user);

      const comboboxes = screen.getAllByRole('combobox');
      fireEvent.mouseDown(comboboxes[2]); // Sort By select
      await user.click(screen.getByRole('option', { name: /imported.*newest/i }));

      await waitFor(() => {
        expect(getGalleryQueryParams()).toEqual(
          expect.objectContaining({ sortBy: 'importedAt', sortOrder: 'desc' }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Filter — date range
  // -------------------------------------------------------------------------

  describe('filter — date range', () => {
    it('should include capturedAtFrom/capturedAtTo in queryParams after filling both date fields', async () => {
      const user = userEvent.setup();
      render(<MediaLibraryPage />);

      await openFilters(user);

      const fromInput = screen.getByLabelText(/captured from/i);
      const toInput = screen.getByLabelText(/captured to/i);
      fireEvent.change(fromInput, { target: { value: '2024-01-01' } });
      fireEvent.change(toInput, { target: { value: '2024-01-31' } });

      await waitFor(() => {
        const params = getGalleryQueryParams();
        expect(params.capturedAtFrom).toBe(new Date('2024-01-01').toISOString());
        expect(params.capturedAtTo).toBe(new Date('2024-01-31').toISOString());
      });
    });
  });

  // -------------------------------------------------------------------------
  // Filter — favorites
  // -------------------------------------------------------------------------

  describe('filter — favorites', () => {
    it('should include favorite:true in queryParams after toggling favorites filter', async () => {
      const user = userEvent.setup();
      render(<MediaLibraryPage />);

      await openFilters(user);

      const favoritesBtn = await screen.findByRole('button', { name: /favorites only/i });
      await user.click(favoritesBtn);

      await waitFor(() => {
        expect(getGalleryQueryParams()).toEqual(
          expect.objectContaining({ favorite: true }),
        );
      });
    });

    it('should drop favorite from queryParams after toggling back to All', async () => {
      const user = userEvent.setup();
      render(<MediaLibraryPage />);

      await openFilters(user);

      const favoritesBtn = await screen.findByRole('button', { name: /favorites only/i });
      await user.click(favoritesBtn); // enable
      const allBtns = screen.getAllByRole('button', { name: /^all$/i });
      await user.click(allBtns[0]); // first match is the ToggleButton inside the Favorites group

      await waitFor(() => {
        expect(getGalleryQueryParams().favorite).toBeFalsy();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Filter — camera / device
  // -------------------------------------------------------------------------

  describe('filter — camera', () => {
    it('should include cameraMake in queryParams after typing a camera make', async () => {
      const user = userEvent.setup();
      render(<MediaLibraryPage />);

      await openFilters(user);

      const cameraMakeInput = screen.getByLabelText(/camera make/i);
      await user.type(cameraMakeInput, 'Canon');

      await waitFor(() => {
        expect(getGalleryQueryParams()).toEqual(
          expect.objectContaining({ cameraMake: 'Canon' }),
        );
      });
    });

    it('should include missingGeo:true in queryParams after enabling "Missing location only"', async () => {
      const user = userEvent.setup();
      render(<MediaLibraryPage />);

      await openFilters(user);

      const missingGeoSwitch = screen.getByLabelText(/missing location only/i);
      await user.click(missingGeoSwitch);

      await waitFor(() => {
        expect(getGalleryQueryParams()).toEqual(
          expect.objectContaining({ missingGeo: true }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Filter — location search
  // -------------------------------------------------------------------------

  describe('filter — location search', () => {
    it('should include location param in queryParams after typing in the search box', async () => {
      const user = userEvent.setup();
      render(<MediaLibraryPage />);

      await openFilters(user);

      const locationInput = await screen.findByPlaceholderText(/california.*costa rica.*yosemite/i);
      await user.type(locationInput, 'Paris');

      await waitFor(() => {
        const params = getGalleryQueryParams();
        expect(typeof params.location).toBe('string');
        expect(params.location).toContain('Paris');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Person filter chip / people filter
  // -------------------------------------------------------------------------

  describe('person filter chip', () => {
    it('does NOT show person chip when no personId in URL', () => {
      render(<MediaLibraryPage />);
      expect(screen.queryByText(/showing photos of/i)).not.toBeInTheDocument();
    });

    it('seeds the multi-select people filter (personIds) from a ?personId= URL deep-link', async () => {
      // On mount, a URL personId seeds peopleFilter.ids via the multi-select
      // filter state — buildParams() then forwards it as personIds/peopleMatch
      // (not the legacy singular personId key, which only applies when the
      // multi-select is empty).
      render(<MediaLibraryPage />, {
        wrapperOptions: { route: '/?personId=person-1&personName=Alice' },
      });

      await waitFor(() => {
        expect(getGalleryQueryParams()).toEqual(
          expect.objectContaining({ personIds: ['person-1'], peopleMatch: 'any' }),
        );
      });
    });

    it('does not include personId in queryParams when absent from the URL', () => {
      render(<MediaLibraryPage />);
      expect(getGalleryQueryParams()).toEqual(
        expect.not.objectContaining({ personId: expect.anything() }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Tiered Places / Tags deep-link filter seeding
  // (mounting at /media?country=|region=|locality=|tag= from PlacesOverviewPage,
  // LevelBrowsePage, or the SearchPage Explore rows must seed the matching
  // filter state so the very first queryParams already includes it.)
  // -------------------------------------------------------------------------

  describe('location and tag deep-link filters', () => {
    it('seeds the country filter from ?country= into queryParams', () => {
      render(<MediaLibraryPage />, {
        wrapperOptions: { route: '/?country=France' },
      });

      expect(getGalleryQueryParams()).toEqual(
        expect.objectContaining({ country: 'France' }),
      );
    });

    it('seeds the region filter from ?region= into queryParams', () => {
      render(<MediaLibraryPage />, {
        wrapperOptions: { route: '/?region=Guanacaste' },
      });

      expect(getGalleryQueryParams()).toEqual(
        expect.objectContaining({ region: 'Guanacaste' }),
      );
    });

    it('seeds the locality filter from ?locality= into queryParams', () => {
      render(<MediaLibraryPage />, {
        wrapperOptions: { route: '/?locality=Liberia' },
      });

      expect(getGalleryQueryParams()).toEqual(
        expect.objectContaining({ locality: 'Liberia' }),
      );
    });

    it('seeds the tag filter from ?tag= as a single-element selection into queryParams', () => {
      render(<MediaLibraryPage />, {
        wrapperOptions: { route: '/?tag=beach' },
      });

      expect(getGalleryQueryParams()).toEqual(
        expect.objectContaining({ tag: 'beach' }),
      );
    });

    it('does not include country/region/locality/tag in queryParams when absent from the URL', () => {
      render(<MediaLibraryPage />);

      expect(getGalleryQueryParams()).toEqual(
        expect.not.objectContaining({
          country: expect.anything(),
          region: expect.anything(),
          locality: expect.anything(),
          tag: expect.anything(),
        }),
      );
    });

    it('shows the seeded tag as a selected (filled) chip once tags load', async () => {
      mockListTags.mockResolvedValue([
        { id: 'tag-1', name: 'beach', count: 3 },
        { id: 'tag-2', name: 'sunset', count: 1 },
      ]);
      render(<MediaLibraryPage />, {
        wrapperOptions: { route: '/?tag=beach' },
      });

      await waitFor(() => {
        expect(screen.getByText(/beach \(3\)/i)).toBeInTheDocument();
      });
    });
  });
});

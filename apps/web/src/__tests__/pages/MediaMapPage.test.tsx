/**
 * MediaMapPage component tests.
 *
 * MediaMapPage is now viewport-driven: it fetches server-side grid clusters
 * from `aggregateLocations()` for the current map bbox/zoom (debounced on
 * pan/zoom), renders one Leaflet marker per cluster, and only fetches
 * per-item points (`listMediaLocations` + `getThumbnails`) lazily when a
 * small multi-item cluster is opened in the "Photos here" drawer.
 *
 * Heavy dependencies are mocked:
 *   - react-leaflet: MapContainer/TileLayer/Marker replaced with lightweight
 *     stubs; useMap/useMapEvents replaced with a shared fake map object so
 *     the page's internal ViewportWatcher/FitToClusters/ClusterLayer helper
 *     components run their real logic against fake Leaflet primitives.
 *   - leaflet: stubs for L.latLngBounds / L.divIcon / L.Icon.Default.
 *   - ../../lib/leaflet-setup: replaced (avoids inline-SVG icon + CSS import).
 *   - services/media: aggregateLocations / listMediaLocations / getThumbnails
 *     / getMedia are all mocked.
 *   - MediaDetailDrawer: replaced with a stub that renders the selected
 *     item id for assertion.
 *
 * useCircle/useAuth are NOT mocked — the real AuthContext/CircleContext
 * providers from `__tests__/utils/test-utils` are used via `wrapperOptions`.
 * MapTimeFilter is also left unmocked (pure MUI, no leaflet dependency).
 *
 * Tests cover the fetch lifecycle (no-circle guard, loading, empty, error,
 * data) and the two cluster-click flows (single-item → detail drawer,
 * small multi-item → "Photos here" drawer data fetch). The large-cluster
 * drill-down (`map.flyTo`) is not asserted — it requires no additional
 * network calls and is the lowest-value path to cover through the mocked
 * leaflet layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';
import type { MapCluster, MediaItem, MediaLocation } from '../../types/media';

// ---------------------------------------------------------------------------
// Hoisted mock state — referenced from inside vi.mock factories below, which
// are hoisted above regular imports, so anything they close over must also
// be created via vi.hoisted().
// ---------------------------------------------------------------------------

const { mockMapMethods } = vi.hoisted(() => {
  return {
    mockMapMethods: {
      getBounds: vi.fn(() => ({
        getWest: () => -85,
        getSouth: () => 9,
        getEast: () => -84,
        getNorth: () => 10,
      })),
      getZoom: vi.fn(() => 10),
      getMaxZoom: vi.fn(() => 18),
      setView: vi.fn(),
      fitBounds: vi.fn(),
      flyTo: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Mock leaflet and related — must be before the component import
// ---------------------------------------------------------------------------

vi.mock('leaflet', () => {
  const latLngBounds = vi.fn().mockReturnValue({ isValid: () => true });
  const divIcon = vi.fn().mockReturnValue({});
  return {
    default: {
      latLngBounds,
      divIcon,
      Icon: {
        Default: class {
          static mergeOptions = vi.fn();
        },
      },
    },
    latLngBounds,
    divIcon,
  };
});

vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('../../lib/leaflet-setup', () => ({ defaultIcon: {} }));

// ---------------------------------------------------------------------------
// Mock react-leaflet
// ---------------------------------------------------------------------------

vi.mock('react-leaflet', () => {
  const MapContainer = ({ children }: any) => (
    <div data-testid="map-container">{children}</div>
  );
  const TileLayer = () => <div data-testid="tile-layer" />;
  const Marker = (props: any) => (
    <button
      type="button"
      data-testid="marker"
      data-lat={props.position?.[0]}
      data-lng={props.position?.[1]}
      onClick={() => props.eventHandlers?.click?.()}
    />
  );
  const useMap = () => mockMapMethods;
  const useMapEvents = () => undefined;
  return { MapContainer, TileLayer, Marker, useMap, useMapEvents };
});

// ---------------------------------------------------------------------------
// Mock MediaDetailDrawer — show selected item id for assertion
// ---------------------------------------------------------------------------

vi.mock('../../components/media/MediaDetailDrawer', () => ({
  MediaDetailDrawer: ({ item, open }: any) =>
    open && item ? <div data-testid="detail-drawer" data-item-id={item.id} /> : null,
}));

// ---------------------------------------------------------------------------
// Mock services/media
// ---------------------------------------------------------------------------

vi.mock('../../services/media', () => ({
  aggregateLocations: vi.fn(),
  listMediaLocations: vi.fn(),
  getThumbnails: vi.fn(),
  getMedia: vi.fn(),
}));

import {
  aggregateLocations,
  listMediaLocations,
  getThumbnails,
  getMedia,
} from '../../services/media';

const mockAggregateLocations = vi.mocked(aggregateLocations);
const mockListMediaLocations = vi.mocked(listMediaLocations);
const mockGetThumbnails = vi.mocked(getThumbnails);
const mockGetMedia = vi.mocked(getMedia);

// ---------------------------------------------------------------------------
// Now import the component under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import MediaMapPage from '../../pages/MediaMapPage';

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

function makeCluster(overrides: Partial<MapCluster> = {}): MapCluster {
  return {
    lat: 9.9281,
    lng: -84.0907,
    count: 1,
    sampleId: 'item-1',
    ...overrides,
  };
}

function makeLocation(overrides: Partial<MediaLocation> = {}): MediaLocation {
  return {
    id: 'item-1',
    takenLat: 9.9281,
    takenLng: -84.0907,
    capturedAt: '2024-06-15T10:30:00.000Z',
    geoLocality: 'La Fortuna',
    ...overrides,
  };
}

function makeFullItem(id: string, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    storageObjectId: 'storage-obj-001',
    addedById: 'user-001',
    circleId: 'circle-1',
    type: 'photo',
    capturedAt: '2024-06-15T10:30:00.000Z',
    capturedAtOffset: null,
    importedAt: '2024-06-16T08:00:00.000Z',
    source: 'web',
    contentHash: null,
    width: 4032,
    height: 3024,
    durationMs: null,
    orientation: null,
    takenLat: 9.9281,
    takenLng: -84.0907,
    takenAltitude: null,
    cameraMake: null,
    cameraModel: null,
    originalFilename: 'photo.jpg',
    description: null,
    favorite: false,
    geoCountry: 'Costa Rica',
    geoCountryCode: 'CR',
    geoAdmin1: 'Alajuela',
    geoAdmin2: null,
    geoLocality: 'La Fortuna',
    geoPlaceName: null,
    geoSource: null,
    geocodedAt: null,
    coordSource: 'exif',
    createdAt: '2024-06-16T08:00:00.000Z',
    updatedAt: '2024-06-16T09:00:00.000Z',
    deletedAt: null,
    archivedAt: null,
    metadata: null,
    thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
    downloadUrl: 'https://cdn.example.com/photo.jpg',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaMapPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAggregateLocations.mockResolvedValue([]);
    mockListMediaLocations.mockResolvedValue([]);
    mockGetThumbnails.mockResolvedValue([]);
    mockGetMedia.mockResolvedValue(makeFullItem('item-1'));
  });

  // -------------------------------------------------------------------------
  // No active circle
  // -------------------------------------------------------------------------

  it('shows a "select a circle" alert and does not fetch when there is no active circle', () => {
    render(<MediaMapPage />, { wrapperOptions: { activeCircle: null } });

    expect(
      screen.getByText(/select a circle to view the map/i),
    ).toBeInTheDocument();
    expect(mockAggregateLocations).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Data fetching lifecycle
  // -------------------------------------------------------------------------

  describe('data fetching', () => {
    it('calls aggregateLocations once the viewport becomes available, scoped to the active circle', async () => {
      render(<MediaMapPage />);

      await waitFor(() => {
        expect(mockAggregateLocations).toHaveBeenCalled();
      });
      expect(mockAggregateLocations).toHaveBeenCalledWith(
        expect.objectContaining({ circleId: 'circle-1' }),
      );
    });

    it('shows a loading indicator while the initial aggregate fetch is pending', async () => {
      mockAggregateLocations.mockReturnValue(new Promise(() => {}));
      render(<MediaMapPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/loading map data/i)).toBeInTheDocument();
      });
    });

    it('removes the loading indicator and renders the map after the fetch resolves', async () => {
      mockAggregateLocations.mockResolvedValue([makeCluster()]);
      render(<MediaMapPage />);

      await waitFor(() => {
        expect(screen.queryByLabelText(/loading map data/i)).not.toBeInTheDocument();
      });
      expect(screen.getByTestId('map-container')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  describe('empty state', () => {
    it('shows the empty-state message when the aggregate returns no clusters', async () => {
      mockAggregateLocations.mockResolvedValue([]);
      render(<MediaMapPage />);

      await waitFor(() => {
        expect(screen.getByText(/no geotagged media here/i)).toBeInTheDocument();
      });
    });

    it('does NOT show the empty-state message when clusters are returned', async () => {
      mockAggregateLocations.mockResolvedValue([makeCluster()]);
      render(<MediaMapPage />);

      await waitFor(() => {
        expect(screen.getByTestId('map-container')).toBeInTheDocument();
      });
      expect(screen.queryByText(/no geotagged media here/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------

  describe('error state', () => {
    it('shows an error alert when aggregateLocations rejects', async () => {
      mockAggregateLocations.mockRejectedValue(new Error('boom'));
      render(<MediaMapPage />);

      await waitFor(() => {
        expect(screen.getByText('boom')).toBeInTheDocument();
      });
      expect(screen.queryByLabelText(/loading map data/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Marker rendering
  // -------------------------------------------------------------------------

  describe('marker rendering', () => {
    it('renders one marker per returned cluster', async () => {
      mockAggregateLocations.mockResolvedValue([
        makeCluster({ lat: 10, lng: -85, count: 1, sampleId: 'item-1' }),
        makeCluster({ lat: 20, lng: -70, count: 5, sampleId: 'cluster-a' }),
      ]);
      render(<MediaMapPage />);

      await waitFor(() => {
        expect(screen.getAllByTestId('marker')).toHaveLength(2);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Single-item cluster click → detail drawer
  // -------------------------------------------------------------------------

  describe('single-item cluster click', () => {
    it('calls getMedia and opens the detail drawer when a count=1 cluster is clicked', async () => {
      mockAggregateLocations.mockResolvedValue([
        makeCluster({ count: 1, sampleId: 'item-42' }),
      ]);
      mockGetMedia.mockResolvedValue(makeFullItem('item-42'));

      render(<MediaMapPage />);

      await waitFor(() => {
        expect(screen.getByTestId('marker')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByTestId('marker'));

      await waitFor(() => {
        expect(mockGetMedia).toHaveBeenCalledWith('item-42');
      });
      await waitFor(() => {
        expect(screen.getByTestId('detail-drawer')).toHaveAttribute(
          'data-item-id',
          'item-42',
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Small multi-item cluster click → "Photos here" drawer data fetch
  // -------------------------------------------------------------------------

  describe('small multi-item cluster click', () => {
    it('fetches drawer points via listMediaLocations and backfills thumbnails via getThumbnails', async () => {
      mockAggregateLocations.mockResolvedValue([
        makeCluster({ count: 5, sampleId: 'cluster-a', lat: 10, lng: -85 }),
      ]);
      mockListMediaLocations.mockResolvedValue([
        makeLocation({ id: 'p1' }),
        makeLocation({ id: 'p2' }),
      ]);
      mockGetThumbnails.mockResolvedValue([
        { id: 'p1', thumbnailUrl: 'https://cdn.example.com/p1.jpg' },
        { id: 'p2', thumbnailUrl: null },
      ]);

      render(<MediaMapPage />);

      await waitFor(() => {
        expect(screen.getByTestId('marker')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByTestId('marker'));

      await waitFor(() => {
        expect(mockListMediaLocations).toHaveBeenCalledWith(
          expect.objectContaining({ circleId: 'circle-1' }),
        );
      });
      await waitFor(() => {
        expect(mockGetThumbnails).toHaveBeenCalledWith('circle-1', ['p1', 'p2']);
      });

      // The "Photos here" drawer heading reflects the loaded point count.
      await waitFor(() => {
        expect(screen.getByText(/photos here \(2\)/i)).toBeInTheDocument();
      });
    });
  });
});

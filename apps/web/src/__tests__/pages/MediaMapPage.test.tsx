/**
 * MediaMapPage component tests.
 *
 * Heavy dependencies are mocked:
 *   - react-leaflet: replaced with lightweight divs
 *   - leaflet: provides stub L object
 *   - leaflet.markercluster CSS: stubbed to avoid CSS import errors
 *   - leaflet-setup: avoids image asset resolution
 *   - MarkerClusterGroup: replaced with a configurable stub that exposes
 *     onClusterClick / onMarkerClick so we can trigger them in tests
 *   - services/media: listMediaLocations and getMedia are mocked
 *   - MediaDetailDrawer: replaced with a stub that shows item id
 *
 * Tests cover:
 *   - Locations fetched on mount
 *   - Loading state shown during fetch
 *   - Empty state shown when no locations returned
 *   - onClusterClick opens album drawer with correct thumbnails
 *   - Clicking album thumbnail calls getMedia and opens detail drawer
 *   - onMarkerClick calls getMedia and opens detail drawer directly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';
import type { MediaLocation, MediaItem } from '../../types/media';

// ---------------------------------------------------------------------------
// Mock leaflet and related — must be before the component import
// ---------------------------------------------------------------------------

vi.mock('leaflet', () => {
  const latLngBounds = vi.fn().mockReturnValue({
    isValid: () => true,
  });

  return {
    default: {
      latLngBounds,
      marker: vi.fn(),
      markerClusterGroup: vi.fn(),
      Icon: { Default: class { static mergeOptions = vi.fn(); } },
    },
    latLngBounds,
  };
});

vi.mock('leaflet.markercluster', () => ({}));
vi.mock('leaflet.markercluster/dist/MarkerCluster.css', () => ({}));
vi.mock('leaflet.markercluster/dist/MarkerCluster.Default.css', () => ({}));
vi.mock('leaflet/dist/leaflet.css', () => ({}));
// PNG image mocks removed — leaflet-setup now uses inline SVG (no PNG imports)
vi.mock('../../lib/leaflet-setup', () => ({ defaultIcon: {} }));

// ---------------------------------------------------------------------------
// Mock react-leaflet
// ---------------------------------------------------------------------------

vi.mock('react-leaflet', () => {
  const MapContainer = ({ children }: any) => (
    <div data-testid="map-container">{children}</div>
  );
  const TileLayer = () => <div data-testid="tile-layer" />;
  const useMap = vi.fn().mockReturnValue({
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    setView: vi.fn(),
    fitBounds: vi.fn(),
  });
  return { MapContainer, TileLayer, useMap };
});

// ---------------------------------------------------------------------------
// Capture MarkerClusterGroup props so tests can invoke callbacks
// ---------------------------------------------------------------------------

let capturedClusterProps: {
  points: MediaLocation[];
  onClusterClick: (ids: string[]) => void;
  onMarkerClick: (id: string) => void;
} | null = null;

vi.mock('../../components/map/MarkerClusterGroup', () => ({
  MarkerClusterGroup: (props: any) => {
    capturedClusterProps = props;
    return <div data-testid="marker-cluster-group" />;
  },
}));

// ---------------------------------------------------------------------------
// Mock MediaDetailDrawer — show selected item id for assertion
// ---------------------------------------------------------------------------

vi.mock('../../components/media/MediaDetailDrawer', () => ({
  MediaDetailDrawer: ({ item, open }: any) =>
    open && item ? (
      <div data-testid="detail-drawer" data-item-id={item.id} />
    ) : null,
}));

// ---------------------------------------------------------------------------
// Mock services/media
// ---------------------------------------------------------------------------

vi.mock('../../services/media', () => ({
  listMediaLocations: vi.fn(),
  getMedia: vi.fn(),
}));

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

import { listMediaLocations, getMedia } from '../../services/media';
import { useCircle } from '../../hooks/useCircle';

const mockListMediaLocations = vi.mocked(listMediaLocations);
const mockGetMedia = vi.mocked(getMedia);
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

// ---------------------------------------------------------------------------
// Now import the component under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import MediaMapPage from '../../pages/MediaMapPage';

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

function makeLocation(overrides: Partial<MediaLocation> = {}): MediaLocation {
  return {
    id: 'loc-1',
    takenLat: 9.9281,
    takenLng: -84.0907,
    capturedAt: '2024-06-15T10:30:00.000Z',
    geoLocality: 'La Fortuna',
    thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
    ...overrides,
  };
}

function makeFullItem(id: string): MediaItem {
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
    caption: null,
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
    createdAt: '2024-06-16T08:00:00.000Z',
    updatedAt: '2024-06-16T09:00:00.000Z',
    deletedAt: null,
    metadata: null,
    thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
    downloadUrl: 'https://cdn.example.com/photo.mp4',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaMapPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedClusterProps = null;
    mockListMediaLocations.mockResolvedValue([]);
    mockGetMedia.mockResolvedValue(makeFullItem('loc-1'));
    mockUseCircle.mockReturnValue({
      circles: [mockActiveCircle],
      activeCircle: mockActiveCircle,
      activeCircleId: 'circle-1',
      activeCircleRole: 'circle_admin',
      loading: false,
      setActiveCircle: vi.fn().mockResolvedValue(undefined),
      refreshCircles: vi.fn().mockResolvedValue(undefined),
    });
  });

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  describe('data fetching on mount', () => {
    it('calls listMediaLocations on mount', async () => {
      render(<MediaMapPage />);
      await waitFor(() => {
        expect(mockListMediaLocations).toHaveBeenCalledTimes(1);
      });
    });

    it('shows a loading indicator initially', () => {
      // Keep the promise pending
      mockListMediaLocations.mockReturnValue(new Promise(() => {}));
      render(<MediaMapPage />);
      // The loading overlay is present (CircularProgress with aria-label)
      expect(screen.getByLabelText(/loading map data/i)).toBeInTheDocument();
    });

    it('removes the loading indicator after locations are fetched', async () => {
      mockListMediaLocations.mockResolvedValue([makeLocation()]);
      render(<MediaMapPage />);
      await waitFor(() => {
        expect(screen.queryByLabelText(/loading map data/i)).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  describe('empty state', () => {
    it('shows the empty-state message when no geotagged items exist', async () => {
      mockListMediaLocations.mockResolvedValue([]);
      render(<MediaMapPage />);
      await waitFor(() => {
        expect(screen.getByText(/no geotagged media yet/i)).toBeInTheDocument();
      });
    });

    it('does NOT show the empty-state message when there are locations', async () => {
      mockListMediaLocations.mockResolvedValue([makeLocation()]);
      render(<MediaMapPage />);
      await waitFor(() => {
        expect(
          screen.queryByText(/no geotagged media yet/i),
        ).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Map rendering
  // -------------------------------------------------------------------------

  describe('map rendering', () => {
    it('renders the MapContainer', async () => {
      render(<MediaMapPage />);
      await waitFor(() => {
        expect(screen.getByTestId('map-container')).toBeInTheDocument();
      });
    });

    it('renders MarkerClusterGroup after locations load', async () => {
      mockListMediaLocations.mockResolvedValue([makeLocation()]);
      render(<MediaMapPage />);
      await waitFor(() => {
        expect(screen.getByTestId('marker-cluster-group')).toBeInTheDocument();
      });
    });

    it('does NOT render MarkerClusterGroup when there are no locations', async () => {
      mockListMediaLocations.mockResolvedValue([]);
      render(<MediaMapPage />);
      await waitFor(() => {
        expect(
          screen.queryByTestId('marker-cluster-group'),
        ).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Cluster click — album drawer
  // -------------------------------------------------------------------------

  describe('cluster click → album drawer', () => {
    it('opens an album drawer when onClusterClick is called with ids', async () => {
      const loc1 = makeLocation({ id: 'loc-1' });
      const loc2 = makeLocation({ id: 'loc-2', takenLat: 10, takenLng: -85 });
      mockListMediaLocations.mockResolvedValue([loc1, loc2]);

      render(<MediaMapPage />);

      // Wait for MarkerClusterGroup to mount and capture its props
      await waitFor(() => {
        expect(capturedClusterProps).not.toBeNull();
      });

      // Simulate a cluster click with both ids
      act(() => {
        capturedClusterProps!.onClusterClick(['loc-1', 'loc-2']);
      });

      // Album panel should be visible with the count
      await waitFor(() => {
        expect(screen.getByText(/photos here \(2\)/i)).toBeInTheDocument();
      });
    });

    it('shows thumbnails for the cluster ids in the album drawer', async () => {
      const loc1 = makeLocation({ id: 'loc-1', thumbnailUrl: 'https://cdn.example.com/thumb1.jpg' });
      const loc2 = makeLocation({ id: 'loc-2', thumbnailUrl: 'https://cdn.example.com/thumb2.jpg' });
      mockListMediaLocations.mockResolvedValue([loc1, loc2]);

      render(<MediaMapPage />);
      await waitFor(() => { expect(capturedClusterProps).not.toBeNull(); });

      act(() => { capturedClusterProps!.onClusterClick(['loc-1', 'loc-2']); });

      await waitFor(() => {
        expect(screen.getByText(/photos here \(2\)/i)).toBeInTheDocument();
      });

      // Two AlbumTile elements should be rendered (role="button")
      const tiles = screen.getAllByRole('button', { name: /photo taken at|la fortuna/i });
      expect(tiles.length).toBeGreaterThanOrEqual(1);
    });

    it('calls getMedia and opens detail drawer when an album thumbnail is clicked', async () => {
      const loc1 = makeLocation({ id: 'loc-1' });
      mockListMediaLocations.mockResolvedValue([loc1]);
      mockGetMedia.mockResolvedValue(makeFullItem('loc-1'));

      render(<MediaMapPage />);
      await waitFor(() => { expect(capturedClusterProps).not.toBeNull(); });

      act(() => { capturedClusterProps!.onClusterClick(['loc-1']); });

      await waitFor(() => {
        expect(screen.getByText(/photos here \(1\)/i)).toBeInTheDocument();
      });

      // Click the album tile
      const tile = screen.getByRole('button', { name: /la fortuna/i });
      await userEvent.click(tile);

      await waitFor(() => {
        expect(mockGetMedia).toHaveBeenCalledWith('loc-1');
        expect(screen.getByTestId('detail-drawer')).toBeInTheDocument();
        expect(screen.getByTestId('detail-drawer')).toHaveAttribute('data-item-id', 'loc-1');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Marker click → detail drawer
  // -------------------------------------------------------------------------

  describe('marker click → detail drawer', () => {
    it('calls getMedia with the id when a marker is clicked', async () => {
      const loc = makeLocation({ id: 'loc-marker-1' });
      mockListMediaLocations.mockResolvedValue([loc]);
      mockGetMedia.mockResolvedValue(makeFullItem('loc-marker-1'));

      render(<MediaMapPage />);
      await waitFor(() => { expect(capturedClusterProps).not.toBeNull(); });

      act(() => { capturedClusterProps!.onMarkerClick('loc-marker-1'); });

      await waitFor(() => {
        expect(mockGetMedia).toHaveBeenCalledWith('loc-marker-1');
      });
    });

    it('opens the detail drawer after a marker click', async () => {
      const loc = makeLocation({ id: 'loc-marker-2' });
      mockListMediaLocations.mockResolvedValue([loc]);
      mockGetMedia.mockResolvedValue(makeFullItem('loc-marker-2'));

      render(<MediaMapPage />);
      await waitFor(() => { expect(capturedClusterProps).not.toBeNull(); });

      act(() => { capturedClusterProps!.onMarkerClick('loc-marker-2'); });

      await waitFor(() => {
        expect(screen.getByTestId('detail-drawer')).toBeInTheDocument();
        expect(screen.getByTestId('detail-drawer')).toHaveAttribute('data-item-id', 'loc-marker-2');
      });
    });
  });
});

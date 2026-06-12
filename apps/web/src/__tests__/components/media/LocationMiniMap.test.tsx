/**
 * LocationMiniMap component tests.
 *
 * react-leaflet and the leaflet-setup module are mocked so no real DOM map
 * is created.  Tests assert:
 *   - MapContainer receives center=[lat, lng]
 *   - A Marker is rendered at the same coordinates
 *   - A Popup appears when a label is supplied, not when it is omitted
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';

// ---------------------------------------------------------------------------
// Mock react-leaflet — emit testable divs
// ---------------------------------------------------------------------------

vi.mock('react-leaflet', () => {
  const MapContainer = ({ center, zoom, children, ...rest }: any) => (
    <div
      data-testid="map-container"
      data-center={JSON.stringify(center)}
      data-zoom={zoom}
      {...rest}
    >
      {children}
    </div>
  );

  const TileLayer = ({ url }: any) => (
    <div data-testid="tile-layer" data-url={url} />
  );

  const Marker = ({ position, children }: any) => (
    <div
      data-testid="marker"
      data-position={JSON.stringify(position)}
    >
      {children}
    </div>
  );

  const Popup = ({ children }: any) => (
    <div data-testid="popup">{children}</div>
  );

  return { MapContainer, TileLayer, Marker, Popup };
});

// Mock the leaflet-setup module (imports leaflet and patches icons)
vi.mock('../../../lib/leaflet-setup', () => ({
  defaultIcon: {},
}));

import { LocationMiniMap } from '../../../components/media/LocationMiniMap';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocationMiniMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('MapContainer', () => {
    it('should render a MapContainer', () => {
      render(<LocationMiniMap lat={9.93} lng={-84.09} />);
      expect(screen.getByTestId('map-container')).toBeInTheDocument();
    });

    it('should pass center=[lat, lng] to MapContainer', () => {
      render(<LocationMiniMap lat={9.9281} lng={-84.0907} />);
      const container = screen.getByTestId('map-container');
      const center = JSON.parse(container.getAttribute('data-center') ?? '[]');
      expect(center).toEqual([9.9281, -84.0907]);
    });

    it('should render a TileLayer', () => {
      render(<LocationMiniMap lat={0} lng={0} />);
      expect(screen.getByTestId('tile-layer')).toBeInTheDocument();
    });

    it('should use OpenStreetMap tile URL', () => {
      render(<LocationMiniMap lat={0} lng={0} />);
      const tileLayer = screen.getByTestId('tile-layer');
      expect(tileLayer.getAttribute('data-url')).toContain('openstreetmap.org');
    });
  });

  describe('Marker', () => {
    it('should render a Marker', () => {
      render(<LocationMiniMap lat={9.93} lng={-84.09} />);
      expect(screen.getByTestId('marker')).toBeInTheDocument();
    });

    it('should place the Marker at [lat, lng]', () => {
      render(<LocationMiniMap lat={48.8566} lng={2.3522} />);
      const marker = screen.getByTestId('marker');
      const position = JSON.parse(marker.getAttribute('data-position') ?? '[]');
      expect(position).toEqual([48.8566, 2.3522]);
    });
  });

  describe('Popup (label)', () => {
    it('should render a Popup with the label text when label is provided', () => {
      render(<LocationMiniMap lat={9.93} lng={-84.09} label="Arenal Volcano" />);
      const popup = screen.getByTestId('popup');
      expect(popup).toBeInTheDocument();
      expect(popup).toHaveTextContent('Arenal Volcano');
    });

    it('should NOT render a Popup when label is omitted', () => {
      render(<LocationMiniMap lat={9.93} lng={-84.09} />);
      expect(screen.queryByTestId('popup')).not.toBeInTheDocument();
    });

    it('should NOT render a Popup when label is null', () => {
      render(<LocationMiniMap lat={9.93} lng={-84.09} label={null} />);
      expect(screen.queryByTestId('popup')).not.toBeInTheDocument();
    });
  });
});

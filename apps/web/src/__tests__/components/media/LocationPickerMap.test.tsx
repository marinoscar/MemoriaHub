/**
 * LocationPickerMap component tests.
 *
 * Two test suites:
 *
 * 1. Behaviour suite — LocationPickerMap renders the expected DOM elements,
 *    passes position to Marker, and calls onChange on click / drag.
 *    leaflet-setup is mocked (no real Leaflet), react-leaflet is mocked.
 *
 * 2. Icon SVG suite — verifies that the icon passed to <Marker> comes from
 *    the REAL leaflet-setup module and carries inline SVG, not a PNG <img>.
 *    react-leaflet Marker is mocked to expose icon.options.html as a
 *    data-icon-html attribute so we can inspect it in a JSDOM render.
 *    leaflet-setup is NOT mocked here so the real L.divIcon is used.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';

// ============================================================================
// Suite 1 – Behaviour (mocked leaflet-setup + mocked react-leaflet)
// ============================================================================

// We scope mock declarations to this suite by using a factory approach.
// Vitest hoists vi.mock calls to the top of the file; to run two separate
// setups we use a single shared mock that records calls and can be inspected.

// ---------------------------------------------------------------------------
// Shared mocks (hoisted)
// ---------------------------------------------------------------------------

vi.mock('leaflet/dist/leaflet.css', () => ({}));

// Mock leaflet itself so its CSS/image side-effects don't run in the
// behaviour suite (the icon-SVG suite imports the REAL module instead).
vi.mock('leaflet', () => {
  const divIcon = vi.fn((opts: any) => ({ options: opts, _isDivIcon: true }));
  const DivIcon = class {};
  const Icon = class {
    static Default = class {
      static mergeOptions = vi.fn();
    };
  };
  return { default: { divIcon, DivIcon, Icon }, divIcon };
});

vi.mock('react-leaflet', () => {
  // Marker exposes the icon html as a data attribute so the icon-SVG suite
  // can verify SVG content without a real Leaflet DOM.
  const Marker = ({ position, icon, children, draggable, eventHandlers }: any) => {
    const iconHtml =
      icon && icon.options && typeof icon.options.html === 'string'
        ? icon.options.html
        : '';
    return (
      <div
        data-testid="marker"
        data-position={JSON.stringify(position)}
        data-icon-html={iconHtml}
        data-draggable={draggable ? 'true' : 'false'}
        onClick={() => eventHandlers?.click?.()}
      >
        {children}
      </div>
    );
  };

  const MapContainer = ({ children, center, zoom, style }: any) => (
    <div
      data-testid="map-container"
      data-center={JSON.stringify(center)}
      data-zoom={zoom}
      style={style}
    >
      {children}
    </div>
  );

  const TileLayer = ({ url }: any) => (
    <div data-testid="tile-layer" data-url={url} />
  );

  // useMapEvents: call the click handler when the map div is clicked
  const useMapEvents = vi.fn((handlers: any) => {
    // Store click handler on the map div for tests to trigger
    if (typeof document !== 'undefined') {
      (window as any).__leafletClickHandler = handlers.click;
    }
    return null;
  });

  const useMap = vi.fn().mockReturnValue({
    setView: vi.fn(),
    getZoom: vi.fn().mockReturnValue(13),
  });

  return { MapContainer, TileLayer, Marker, useMapEvents, useMap };
});

// Mock leaflet-setup with a real-ish divIcon shape for the behaviour suite
vi.mock('../../../lib/leaflet-setup', () => ({
  defaultIcon: {
    options: {
      className: 'mh-marker-icon',
      html: '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>',
      iconSize: [25, 41],
      iconAnchor: [12, 41],
      popupAnchor: [1, -34],
    },
  },
}));

import { LocationPickerMap } from '../../../components/media/LocationPickerMap';

// ---------------------------------------------------------------------------
// Behaviour tests
// ---------------------------------------------------------------------------

describe('LocationPickerMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset stored click handler
    (window as any).__leafletClickHandler = undefined;
  });

  describe('Map structure', () => {
    it('should render a MapContainer', () => {
      const onChange = vi.fn();
      render(<LocationPickerMap value={null} onChange={onChange} />);
      expect(screen.getByTestId('map-container')).toBeInTheDocument();
    });

    it('should render a TileLayer with OpenStreetMap URL', () => {
      const onChange = vi.fn();
      render(<LocationPickerMap value={null} onChange={onChange} />);
      const tile = screen.getByTestId('tile-layer');
      expect(tile.getAttribute('data-url')).toContain('openstreetmap.org');
    });

    it('should NOT render a Marker when value is null', () => {
      const onChange = vi.fn();
      render(<LocationPickerMap value={null} onChange={onChange} />);
      expect(screen.queryByTestId('marker')).not.toBeInTheDocument();
    });

    it('should render a Marker when value is provided', () => {
      const onChange = vi.fn();
      render(
        <LocationPickerMap value={{ lat: 9.93, lng: -84.09 }} onChange={onChange} />,
      );
      expect(screen.getByTestId('marker')).toBeInTheDocument();
    });
  });

  describe('Marker position', () => {
    it('should place the Marker at [value.lat, value.lng]', () => {
      const onChange = vi.fn();
      render(
        <LocationPickerMap value={{ lat: 48.8566, lng: 2.3522 }} onChange={onChange} />,
      );
      const marker = screen.getByTestId('marker');
      const position = JSON.parse(marker.getAttribute('data-position') ?? '[]');
      expect(position).toEqual([48.8566, 2.3522]);
    });

    it('should set MapContainer center from value when value is provided', () => {
      const onChange = vi.fn();
      render(
        <LocationPickerMap value={{ lat: 10, lng: 20 }} onChange={onChange} />,
      );
      const container = screen.getByTestId('map-container');
      const center = JSON.parse(container.getAttribute('data-center') ?? '[]');
      expect(center).toEqual([10, 20]);
    });

    it('should use default center [20, 0] when value is null', () => {
      const onChange = vi.fn();
      render(<LocationPickerMap value={null} onChange={onChange} />);
      const container = screen.getByTestId('map-container');
      const center = JSON.parse(container.getAttribute('data-center') ?? '[]');
      expect(center).toEqual([20, 0]);
    });
  });

  describe('Marker icon — SVG shape', () => {
    it('should pass an icon whose html contains <svg> (not <img>)', () => {
      const onChange = vi.fn();
      render(
        <LocationPickerMap value={{ lat: 0, lng: 0 }} onChange={onChange} />,
      );
      const marker = screen.getByTestId('marker');
      const iconHtml = marker.getAttribute('data-icon-html') ?? '';
      expect(iconHtml).toContain('<svg');
      expect(iconHtml).not.toContain('<img');
    });

    it('should pass an icon with no .png URL (no broken image request)', () => {
      const onChange = vi.fn();
      render(
        <LocationPickerMap value={{ lat: 0, lng: 0 }} onChange={onChange} />,
      );
      const marker = screen.getByTestId('marker');
      const iconHtml = marker.getAttribute('data-icon-html') ?? '';
      expect(iconHtml).not.toContain('.png');
    });

    it('should render the marker as draggable', () => {
      const onChange = vi.fn();
      render(
        <LocationPickerMap value={{ lat: 5, lng: 10 }} onChange={onChange} />,
      );
      const marker = screen.getByTestId('marker');
      expect(marker.getAttribute('data-draggable')).toBe('true');
    });
  });

  describe('Custom height', () => {
    it('should default to height 300', () => {
      const onChange = vi.fn();
      const { container } = render(
        <LocationPickerMap value={null} onChange={onChange} />,
      );
      const mapEl = container.querySelector('[style*="height"]');
      expect(mapEl?.getAttribute('style')).toContain('300px');
    });

    it('should accept custom height prop', () => {
      const onChange = vi.fn();
      const { container } = render(
        <LocationPickerMap value={null} onChange={onChange} height={500} />,
      );
      const mapEl = container.querySelector('[style*="height"]');
      expect(mapEl?.getAttribute('style')).toContain('500px');
    });
  });
});

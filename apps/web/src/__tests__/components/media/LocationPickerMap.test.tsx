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
  const Marker = ({ position, icon, children, draggable, opacity, eventHandlers }: any) => {
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
        data-opacity={opacity === undefined ? '' : String(opacity)}
        onClick={() => eventHandlers?.click?.()}
        // Double-click stands in for a Leaflet dragend so tests can exercise
        // the drag path without a real Leaflet DOM.
        onDoubleClick={() =>
          eventHandlers?.dragend?.({ target: { getLatLng: () => ({ lat: 40.7, lng: -74 }) } })
        }
      >
        {children}
      </div>
    );
  };

  const MapContainer = ({ children, center, zoom, style, scrollWheelZoom }: any) => (
    <div
      data-testid="map-container"
      data-center={JSON.stringify(center)}
      data-zoom={zoom}
      data-scroll-wheel-zoom={String(scrollWheelZoom)}
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

    // Issue #376 fix 2: a null value used to render NO marker at all, leaving
    // nothing to grab and the click affordance undiscoverable.
    it('should render a muted DRAGGABLE placeholder Marker when value is null', () => {
      const onChange = vi.fn();
      render(<LocationPickerMap value={null} onChange={onChange} />);
      const marker = screen.getByTestId('marker');
      expect(marker).toBeInTheDocument();
      expect(marker.getAttribute('data-draggable')).toBe('true');
      // Muted styling — an opacity below 1 marks it as "not chosen yet".
      const opacity = Number(marker.getAttribute('data-opacity'));
      expect(opacity).toBeGreaterThan(0);
      expect(opacity).toBeLessThan(1);
    });

    it('should place the placeholder Marker at the map centre when value is null', () => {
      const onChange = vi.fn();
      render(
        <LocationPickerMap
          value={null}
          onChange={onChange}
          initialCenter={{ lat: 9.93, lng: -84.09 }}
        />,
      );
      const marker = screen.getByTestId('marker');
      expect(JSON.parse(marker.getAttribute('data-position') ?? '[]')).toEqual([9.93, -84.09]);
    });

    it('should report a coordinate when the placeholder Marker is dragged', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<LocationPickerMap value={null} onChange={onChange} />);

      await user.dblClick(screen.getByTestId('marker'));

      expect(onChange).toHaveBeenCalledWith({ lat: 40.7, lng: -74 });
    });

    it('should render the placeholder Marker with the inline-SVG defaultIcon', () => {
      const onChange = vi.fn();
      render(<LocationPickerMap value={null} onChange={onChange} />);
      const iconHtml = screen.getByTestId('marker').getAttribute('data-icon-html') ?? '';
      expect(iconHtml).toContain('<svg');
      expect(iconHtml).not.toContain('.png');
    });

    // The three non-picker call sites (SearchPanel, ActionParamEditor,
    // ConditionValueEditor) opt out, restoring the pre-#376 "no marker at all"
    // look so they stay visually unchanged.
    it('should render NO Marker when value is null and showPlaceholderMarker is false', () => {
      const onChange = vi.fn();
      render(
        <LocationPickerMap value={null} onChange={onChange} showPlaceholderMarker={false} />,
      );
      expect(screen.queryByTestId('marker')).not.toBeInTheDocument();
    });

    it('should still render the real Marker when a value exists and the placeholder is off', () => {
      const onChange = vi.fn();
      render(
        <LocationPickerMap
          value={{ lat: 9.93, lng: -84.09 }}
          onChange={onChange}
          showPlaceholderMarker={false}
        />,
      );
      const marker = screen.getByTestId('marker');
      expect(JSON.parse(marker.getAttribute('data-position') ?? '[]')).toEqual([9.93, -84.09]);
      // The real pin is never muted.
      expect(marker.getAttribute('data-opacity')).toBe('');
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

  // -------------------------------------------------------------------------
  // Issue #376 fix 3 — initialCenter framing hint
  // -------------------------------------------------------------------------
  describe('initialCenter', () => {
    it('opens on initialCenter (zoomed in) when there is no value', () => {
      const onChange = vi.fn();
      render(
        <LocationPickerMap
          value={null}
          onChange={onChange}
          initialCenter={{ lat: 48.8566, lng: 2.3522 }}
        />,
      );
      const container = screen.getByTestId('map-container');
      expect(JSON.parse(container.getAttribute('data-center') ?? '[]')).toEqual([48.8566, 2.3522]);
      expect(container.getAttribute('data-zoom')).not.toBe('2');
    });

    it('is outranked by an actual value', () => {
      const onChange = vi.fn();
      render(
        <LocationPickerMap
          value={{ lat: 10, lng: 20 }}
          onChange={onChange}
          initialCenter={{ lat: 48.8566, lng: 2.3522 }}
        />,
      );
      const container = screen.getByTestId('map-container');
      expect(JSON.parse(container.getAttribute('data-center') ?? '[]')).toEqual([10, 20]);
    });
  });

  // -------------------------------------------------------------------------
  // Issue #376 fix 4 — scrollWheelZoom is a prop, default on
  // -------------------------------------------------------------------------
  describe('scrollWheelZoom', () => {
    it('defaults to true', () => {
      render(<LocationPickerMap value={null} onChange={vi.fn()} />);
      expect(screen.getByTestId('map-container').getAttribute('data-scroll-wheel-zoom')).toBe(
        'true',
      );
    });

    it('can be turned off by the caller', () => {
      render(<LocationPickerMap value={null} onChange={vi.fn()} scrollWheelZoom={false} />);
      expect(screen.getByTestId('map-container').getAttribute('data-scroll-wheel-zoom')).toBe(
        'false',
      );
    });
  });
});

// ============================================================================
// Issue #376 fix 1 — "Use my location"
// ============================================================================

describe('LocationPickerMap — Use my location', () => {
  const getCurrentPosition = vi.fn();

  /** Position fixture used by the stubbed geolocation API. */
  function makePosition(overrides: Partial<{ latitude: number; longitude: number }> = {}) {
    return { coords: { latitude: 9.9281, longitude: -84.0907, ...overrides } };
  }

  /** GeolocationPositionError-shaped fixture. */
  function makeGeoError(overrides: Partial<{ code: number }> = {}) {
    return { code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, ...overrides };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentPosition.mockImplementation((success: (p: unknown) => void) => {
      success(makePosition());
    });
    Object.defineProperty(globalThis.navigator, 'geolocation', {
      value: { getCurrentPosition },
      configurable: true,
      writable: true,
    });
  });

  it('does NOT call onChange from the on-mount auto-locate', () => {
    const onChange = vi.fn();
    render(<LocationPickerMap value={null} onChange={onChange} />);

    // The recenter-only probe ran…
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    // …but must never overwrite/author a coordinate.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('calls onChange on an explicit press when geolocateSetsValue is true (default)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LocationPickerMap value={null} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /use my location/i }));

    expect(onChange).toHaveBeenCalledWith({ lat: 9.9281, lng: -84.0907 });
  });

  it('does NOT call onChange on an explicit press when geolocateSetsValue is false', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LocationPickerMap value={null} onChange={onChange} geolocateSetsValue={false} />,
    );

    await user.click(screen.getByRole('button', { name: /use my location/i }));

    // Still recentered (the probe ran) but the value is untouched.
    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('surfaces MapControls-style copy when permission is denied', async () => {
    const user = userEvent.setup();
    getCurrentPosition.mockImplementation(
      (_success: unknown, failure: (e: unknown) => void) => {
        failure(makeGeoError({ code: 1 }));
      },
    );
    render(<LocationPickerMap value={null} onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /use my location/i }));

    expect(await screen.findByText(/location permission denied/i)).toBeInTheDocument();
  });

  it('surfaces the generic failure copy for a non-permission error', async () => {
    const user = userEvent.setup();
    getCurrentPosition.mockImplementation(
      (_success: unknown, failure: (e: unknown) => void) => {
        failure(makeGeoError({ code: 3 }));
      },
    );
    render(<LocationPickerMap value={null} onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /use my location/i }));

    expect(await screen.findByText(/could not determine your location/i)).toBeInTheDocument();
  });

  it('stays silent when the on-mount probe fails', async () => {
    getCurrentPosition.mockImplementation(
      (_success: unknown, failure: (e: unknown) => void) => {
        failure(makeGeoError({ code: 1 }));
      },
    );
    render(<LocationPickerMap value={null} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText(/location permission denied/i)).not.toBeInTheDocument();
    });
  });
});

/**
 * Component tests — MapControls
 *
 * MapControls is a top-left MUI <Paper> stack of IconButtons that drives a
 * Leaflet map instance imperatively: Zoom In (map.zoomIn), Zoom Out
 * (map.zoomOut), "Fit to my photos" (map.fitBounds/setView against the
 * circle's true photo extent — mirrors MediaMapPage's FitToExtent helper),
 * and "Go to my current location" (navigator.geolocation.getCurrentPosition
 * → map.setView).
 *
 * `leaflet` is mocked (only `L.latLngBounds` matters here — the recenter
 * handler calls it to build the fitBounds argument) so we can assert exactly
 * what map.fitBounds was called with, mirroring the convention used in
 * MediaMapPage.test.tsx.
 *
 * Geolocation is invoked ONLY by an explicit click on the locate button —
 * never automatically on mount — per the component's own doc comment; this
 * is asserted explicitly below as a regression guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../../../__tests__/utils/test-utils';
import type { LocationExtent } from '../../../types/media';

// ---------------------------------------------------------------------------
// Hoisted mock state — referenced from inside the vi.mock('leaflet', ...)
// factory below, which is hoisted above regular imports.
// ---------------------------------------------------------------------------

const { mockMapMethods } = vi.hoisted(() => {
  return {
    mockMapMethods: {
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      fitBounds: vi.fn(),
      setView: vi.fn(),
    },
  };
});

vi.mock('leaflet', () => {
  const latLngBounds = vi.fn().mockReturnValue({ isValid: () => true });
  return {
    default: { latLngBounds },
    latLngBounds,
  };
});

import L from 'leaflet';
import { MapControls } from '../MapControls';

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

function makeExtent(overrides: Partial<LocationExtent> = {}): LocationExtent {
  return {
    minLat: 9.5,
    minLng: -85.0,
    maxLat: 10.5,
    maxLng: -84.0,
    count: 12,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MapControls', () => {
  const mockGetCurrentPosition = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentPosition.mockReset();
    Object.defineProperty(window.navigator, 'geolocation', {
      value: { getCurrentPosition: mockGetCurrentPosition, watchPosition: vi.fn() },
      configurable: true,
    });
  });

  // -------------------------------------------------------------------------
  // Zoom In / Zoom Out
  // -------------------------------------------------------------------------

  it('calls map.zoomIn() when the Zoom In button is clicked', () => {
    render(<MapControls map={mockMapMethods as never} extent={makeExtent()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    expect(mockMapMethods.zoomIn).toHaveBeenCalledTimes(1);
  });

  it('calls map.zoomOut() when the Zoom Out button is clicked', () => {
    render(<MapControls map={mockMapMethods as never} extent={makeExtent()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));

    expect(mockMapMethods.zoomOut).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // "Fit to my photos"
  // -------------------------------------------------------------------------

  describe('"Fit to my photos"', () => {
    it('calls map.fitBounds with the extent bounds when extent is non-null', () => {
      const extent = makeExtent({ minLat: 9.5, minLng: -85, maxLat: 10.5, maxLng: -84 });
      render(<MapControls map={mockMapMethods as never} extent={extent} />);

      fireEvent.click(screen.getByRole('button', { name: 'Fit to my photos' }));

      expect(L.latLngBounds).toHaveBeenCalledWith([
        [extent.minLat, extent.minLng],
        [extent.maxLat, extent.maxLng],
      ]);
      expect(mockMapMethods.fitBounds).toHaveBeenCalledWith(
        (L.latLngBounds as ReturnType<typeof vi.fn>).mock.results[0].value,
        expect.objectContaining({ padding: expect.any(Array) }),
      );
    });

    it('uses setView instead of fitBounds for a single-point extent (min === max)', () => {
      const extent = makeExtent({
        minLat: 9.9281,
        minLng: -84.0907,
        maxLat: 9.9281,
        maxLng: -84.0907,
      });
      render(<MapControls map={mockMapMethods as never} extent={extent} />);

      fireEvent.click(screen.getByRole('button', { name: 'Fit to my photos' }));

      expect(mockMapMethods.setView).toHaveBeenCalledWith(
        [extent.minLat, extent.minLng],
        expect.any(Number),
      );
      expect(mockMapMethods.fitBounds).not.toHaveBeenCalled();
    });

    it('disables the button and never calls fitBounds/setView when extent is null', () => {
      render(<MapControls map={mockMapMethods as never} extent={null} />);

      const button = screen.getByRole('button', { name: 'Fit to my photos' });
      expect(button).toBeDisabled();

      // Disabled buttons don't fire click handlers, but assert defensively
      // that no call happened either way.
      fireEvent.click(button);
      expect(mockMapMethods.fitBounds).not.toHaveBeenCalled();
      expect(mockMapMethods.setView).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // "Go to my current location"
  // -------------------------------------------------------------------------

  describe('"Go to my current location"', () => {
    it('does not invoke geolocation on mount', () => {
      render(<MapControls map={mockMapMethods as never} extent={makeExtent()} />);

      expect(mockGetCurrentPosition).not.toHaveBeenCalled();
    });

    it('calls map.setView with the resolved coordinates on success', () => {
      mockGetCurrentPosition.mockImplementation((success: PositionCallback) => {
        success({
          coords: { latitude: 9.9281, longitude: -84.0907 },
        } as GeolocationPosition);
      });
      render(<MapControls map={mockMapMethods as never} extent={makeExtent()} />);

      fireEvent.click(screen.getByRole('button', { name: 'Go to my current location' }));

      expect(mockGetCurrentPosition).toHaveBeenCalledTimes(1);
      expect(mockMapMethods.setView).toHaveBeenCalledWith(
        [9.9281, -84.0907],
        expect.any(Number),
      );
    });

    it('does not throw and shows a permission-denied alert when geolocation errors with PERMISSION_DENIED', async () => {
      mockGetCurrentPosition.mockImplementation(
        (_success: PositionCallback, error: PositionErrorCallback) => {
          error({
            code: 1,
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3,
          } as GeolocationPositionError);
        },
      );
      render(<MapControls map={mockMapMethods as never} extent={makeExtent()} />);

      expect(() =>
        fireEvent.click(screen.getByRole('button', { name: 'Go to my current location' })),
      ).not.toThrow();

      await waitFor(() => {
        expect(screen.getByText('Location permission denied.')).toBeInTheDocument();
      });
      expect(mockMapMethods.setView).not.toHaveBeenCalled();
    });

    it('shows a generic error alert for a non-permission geolocation error', async () => {
      mockGetCurrentPosition.mockImplementation(
        (_success: PositionCallback, error: PositionErrorCallback) => {
          error({
            code: 2,
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3,
          } as GeolocationPositionError);
        },
      );
      render(<MapControls map={mockMapMethods as never} extent={makeExtent()} />);

      fireEvent.click(screen.getByRole('button', { name: 'Go to my current location' }));

      await waitFor(() => {
        expect(screen.getByText('Could not determine your location.')).toBeInTheDocument();
      });
      expect(mockMapMethods.setView).not.toHaveBeenCalled();
    });

    it('invokes geolocation only on an explicit locate-button click, never from other button clicks', () => {
      render(<MapControls map={mockMapMethods as never} extent={makeExtent()} />);

      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
      fireEvent.click(screen.getByRole('button', { name: 'Fit to my photos' }));
      expect(mockGetCurrentPosition).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Go to my current location' }));
      expect(mockGetCurrentPosition).toHaveBeenCalledTimes(1);
    });
  });
});

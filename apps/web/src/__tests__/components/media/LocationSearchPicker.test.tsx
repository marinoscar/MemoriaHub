/**
 * LocationSearchPicker — unit tests.
 *
 * LocationPickerMap is mocked to a simple div that exposes a button to
 * simulate pin placement. searchPlaces and reverseGeocode are mocked at the
 * service level so the debounced place search, the 503 fallback, and the
 * reverse-geocode preview can be exercised without real network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { LocationSearchPicker } from '../../../components/media/LocationSearchPicker';

// ---------------------------------------------------------------------------
// Mock LocationPickerMap — exposes a button to simulate pin placement
// ---------------------------------------------------------------------------
vi.mock('../../../components/media/LocationPickerMap', () => ({
  LocationPickerMap: vi.fn(
    ({
      onChange,
    }: {
      value: { lat: number; lng: number } | null;
      onChange: (latlng: { lat: number; lng: number }) => void;
      height?: number;
      center?: [number, number];
      initialCenter?: { lat: number; lng: number };
      scrollWheelZoom?: boolean;
      geolocateSetsValue?: boolean;
      showPlaceholderMarker?: boolean;
    }) => (
      <div data-testid="location-picker-map">
        <button
          type="button"
          data-testid="set-pin"
          onClick={() => onChange({ lat: 9.9281, lng: -84.0907 })}
        >
          Set Pin
        </button>
      </div>
    ),
  ),
}));

// ---------------------------------------------------------------------------
// Mock media service functions
// ---------------------------------------------------------------------------
vi.mock('../../../services/media', () => ({
  searchPlaces: vi.fn(),
  reverseGeocode: vi.fn(),
}));

import { searchPlaces, reverseGeocode } from '../../../services/media';
import { LocationPickerMap } from '../../../components/media/LocationPickerMap';

const mockSearchPlaces = vi.mocked(searchPlaces);
const mockReverseGeocode = vi.mocked(reverseGeocode);
const mockLocationPickerMap = vi.mocked(LocationPickerMap);

/** Reverse-geocode result factory — override any field, `null` blanks it. */
function makeGeoResult(overrides: Partial<Record<string, string | null>> = {}) {
  return {
    country: 'Costa Rica',
    countryCode: 'CR',
    admin1: 'Alajuela',
    admin2: null,
    locality: 'La Fortuna',
    placeName: 'Arenal',
    ...overrides,
  } as never;
}

const geoResult = makeGeoResult();

/** Props the stubbed LocationPickerMap was last rendered with. */
function lastMapProps(): Record<string, unknown> {
  const calls = mockLocationPickerMap.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as unknown as Record<string, unknown>;
}

describe('LocationSearchPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchPlaces.mockResolvedValue([]);
    mockReverseGeocode.mockResolvedValue(geoResult);
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  it('renders the search field and the map', () => {
    render(<LocationSearchPicker value={null} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/search place/i)).toBeInTheDocument();
    expect(screen.getByTestId('location-picker-map')).toBeInTheDocument();
  });

  it('does not call searchPlaces when input is fewer than 2 chars', async () => {
    const user = userEvent.setup();
    render(<LocationSearchPicker value={null} onChange={vi.fn()} />);

    await user.type(screen.getByLabelText(/search place/i), 'S');

    expect(mockSearchPlaces).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Debounced search + selection
  // -------------------------------------------------------------------------
  it('calls searchPlaces after debounce and fires onChange with the selected option', async () => {
    mockSearchPlaces.mockResolvedValue([{ lat: 10, lng: 20, label: 'Test City' }]);
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<LocationSearchPicker value={null} onChange={onChange} />);

    await user.type(screen.getByLabelText(/search place/i), 'Test');

    // Debounce (400ms) not yet elapsed immediately after typing.
    expect(mockSearchPlaces).not.toHaveBeenCalled();

    await waitFor(
      () => {
        expect(mockSearchPlaces).toHaveBeenCalledWith('Test', 8);
      },
      { timeout: 2000 },
    );

    // The returned option is offered; selecting it reports the coordinates up.
    const option = await screen.findByText('Test City', {}, { timeout: 2000 });
    await user.click(option);

    expect(onChange).toHaveBeenCalledWith({ lat: 10, lng: 20 });
  });

  // -------------------------------------------------------------------------
  // 503 fallback
  // -------------------------------------------------------------------------
  it('hides the typeahead and shows the unavailable alert on a 503 error', async () => {
    const { ApiError } = await import('../../../services/api');
    mockSearchPlaces.mockRejectedValue(new ApiError('Service Unavailable', 503));
    const user = userEvent.setup();
    render(<LocationSearchPicker value={null} onChange={vi.fn()} />);

    await user.type(screen.getByLabelText(/search place/i), 'San');

    await waitFor(
      () => {
        expect(screen.getByText(/place search unavailable/i)).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    expect(screen.queryByLabelText(/search place/i)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Reverse-geocode preview
  // -------------------------------------------------------------------------
  it('reverse-geocodes and renders the place label when value is set', async () => {
    render(
      <LocationSearchPicker value={{ lat: 9.9281, lng: -84.0907 }} onChange={vi.fn()} />,
    );

    await waitFor(() => {
      expect(mockReverseGeocode).toHaveBeenCalledWith(9.9281, -84.0907);
    });
    expect(await screen.findByText(/La Fortuna/)).toBeInTheDocument();
  });

  it('does not render the preview box when showPreview is false', async () => {
    render(
      <LocationSearchPicker
        value={{ lat: 9.9281, lng: -84.0907 }}
        onChange={vi.fn()}
        showPreview={false}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('location-confirm-row')).not.toBeInTheDocument();
    });
    expect(mockReverseGeocode).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Issue #376 fix 4 — the confirm row
  // -------------------------------------------------------------------------
  describe('confirm row', () => {
    it('shows the resolving state while the address lookup is in flight', async () => {
      // Never settles — holds the component in the resolving state.
      mockReverseGeocode.mockReturnValue(new Promise(() => {}) as never);

      render(
        <LocationSearchPicker value={{ lat: 9.9281, lng: -84.0907 }} onChange={vi.fn()} />,
      );

      expect(await screen.findByText(/finding address/i)).toBeInTheDocument();
      expect(screen.getByTestId('location-confirm-row')).toBeInTheDocument();
      expect(screen.queryByText(/use this location/i)).not.toBeInTheDocument();
    });

    it('reads "Use this location: <address>" once resolved', async () => {
      render(
        <LocationSearchPicker value={{ lat: 9.9281, lng: -84.0907 }} onChange={vi.fn()} />,
      );

      expect(
        await screen.findByText(/use this location: La Fortuna, Alajuela, Costa Rica/i),
      ).toBeInTheDocument();
      // The raw coordinate stays visible underneath.
      expect(screen.getByText(/9\.92810, -84\.09070/)).toBeInTheDocument();
    });

    it('falls back to "Coordinates only" when the lookup returns no address parts', async () => {
      mockReverseGeocode.mockResolvedValue(
        makeGeoResult({ locality: null, admin1: null, country: null }),
      );

      render(
        <LocationSearchPicker value={{ lat: 9.9281, lng: -84.0907 }} onChange={vi.fn()} />,
      );

      expect(
        await screen.findByText(/coordinates only — no address found/i),
      ).toBeInTheDocument();
    });

    it('falls back to "Coordinates only" when the lookup fails outright', async () => {
      mockReverseGeocode.mockRejectedValue(new Error('boom'));

      render(
        <LocationSearchPicker value={{ lat: 9.9281, lng: -84.0907 }} onChange={vi.fn()} />,
      );

      expect(
        await screen.findByText(/coordinates only — no address found/i),
      ).toBeInTheDocument();
    });

    it('renders no confirm row at all when there is no coordinate yet', () => {
      render(<LocationSearchPicker value={null} onChange={vi.fn()} />);
      expect(screen.queryByTestId('location-confirm-row')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Issue #376 fixes 1 + 3 + 4 — props forwarded to the map
  // -------------------------------------------------------------------------
  describe('map props', () => {
    it('forwards initialCenter to the map', () => {
      render(
        <LocationSearchPicker
          value={null}
          onChange={vi.fn()}
          initialCenter={{ lat: 48.8566, lng: 2.3522 }}
        />,
      );
      expect(lastMapProps().initialCenter).toEqual({ lat: 48.8566, lng: 2.3522 });
    });

    it('enables all three behavioural additions by default', () => {
      render(<LocationSearchPicker value={null} onChange={vi.fn()} />);
      expect(lastMapProps().scrollWheelZoom).toBe(true);
      expect(lastMapProps().geolocateSetsValue).toBe(true);
      expect(lastMapProps().showPlaceholderMarker).toBe(true);
    });

    it('lets the caller turn all three off', () => {
      render(
        <LocationSearchPicker
          value={null}
          onChange={vi.fn()}
          scrollWheelZoom={false}
          geolocateSetsValue={false}
          showPlaceholderMarker={false}
        />,
      );
      expect(lastMapProps().scrollWheelZoom).toBe(false);
      expect(lastMapProps().geolocateSetsValue).toBe(false);
      expect(lastMapProps().showPlaceholderMarker).toBe(false);
    });
  });
});

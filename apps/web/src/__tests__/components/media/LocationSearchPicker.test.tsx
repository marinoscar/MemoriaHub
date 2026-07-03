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
  LocationPickerMap: ({
    onChange,
  }: {
    value: { lat: number; lng: number } | null;
    onChange: (latlng: { lat: number; lng: number }) => void;
    height?: number;
    center?: [number, number];
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
}));

// ---------------------------------------------------------------------------
// Mock media service functions
// ---------------------------------------------------------------------------
vi.mock('../../../services/media', () => ({
  searchPlaces: vi.fn(),
  reverseGeocode: vi.fn(),
}));

import { searchPlaces, reverseGeocode } from '../../../services/media';

const mockSearchPlaces = vi.mocked(searchPlaces);
const mockReverseGeocode = vi.mocked(reverseGeocode);

const geoResult = {
  country: 'Costa Rica',
  countryCode: 'CR',
  admin1: 'Alajuela',
  admin2: null,
  locality: 'La Fortuna',
  placeName: 'Arenal',
};

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
      expect(screen.queryByText(/pin:/i)).not.toBeInTheDocument();
    });
    expect(mockReverseGeocode).not.toHaveBeenCalled();
  });
});

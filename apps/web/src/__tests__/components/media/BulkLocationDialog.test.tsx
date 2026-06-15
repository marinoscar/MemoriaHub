/**
 * BulkLocationDialog — unit tests.
 *
 * LocationPickerMap is mocked to a simple div that calls onChange with a
 * test location to simulate pin placement. searchPlaces, reverseGeocode,
 * and bulkUpdateMedia are mocked at the service level.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { BulkLocationDialog } from '../../../components/media/BulkLocationDialog';

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
  bulkUpdateMedia: vi.fn(),
  getDashboard: vi.fn(),
  listMedia: vi.fn(),
  getMedia: vi.fn(),
  patchMedia: vi.fn(),
  initUpload: vi.fn(),
  uploadPart: vi.fn(),
  completeUpload: vi.fn(),
  registerMedia: vi.fn(),
  listTags: vi.fn(),
  bulkTags: vi.fn(),
  bulkDelete: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock ApiError for 503 test
// ---------------------------------------------------------------------------
vi.mock('../../../services/api', async () => {
  const actual = await vi.importActual('../../../services/api');
  return actual;
});

import { searchPlaces, reverseGeocode, bulkUpdateMedia } from '../../../services/media';

const mockSearchPlaces = vi.mocked(searchPlaces);
const mockReverseGeocode = vi.mocked(reverseGeocode);
const mockBulkUpdateMedia = vi.mocked(bulkUpdateMedia);

// ---------------------------------------------------------------------------
// Default props
// ---------------------------------------------------------------------------
const defaultProps = {
  open: true,
  onClose: vi.fn(),
  circleId: 'circle-1',
  ids: ['item-1', 'item-2'],
  onSuccess: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('BulkLocationDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchPlaces.mockResolvedValue([]);
    mockReverseGeocode.mockResolvedValue({
      country: 'Costa Rica',
      countryCode: 'CR',
      admin1: 'Alajuela',
      admin2: null,
      locality: 'La Fortuna',
      placeName: 'Arenal',
    });
    mockBulkUpdateMedia.mockResolvedValue({ updated: 2 });
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  describe('Rendering', () => {
    it('renders the dialog title with item count', () => {
      render(<BulkLocationDialog {...defaultProps} />);
      expect(screen.getByText(/set location for 2 items/i)).toBeInTheDocument();
    });

    it('renders the map placeholder', () => {
      render(<BulkLocationDialog {...defaultProps} />);
      expect(screen.getByTestId('location-picker-map')).toBeInTheDocument();
    });

    it('renders Cancel and Apply buttons', () => {
      render(<BulkLocationDialog {...defaultProps} />);
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /apply/i })).toBeInTheDocument();
    });

    it('Apply button is disabled when no pin placed', () => {
      render(<BulkLocationDialog {...defaultProps} />);
      expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
    });

    it('renders "Clear Location" button', () => {
      render(<BulkLocationDialog {...defaultProps} />);
      expect(screen.getByRole('button', { name: /clear location/i })).toBeInTheDocument();
    });

    it('uses singular "item" for single id', () => {
      render(<BulkLocationDialog {...defaultProps} ids={['item-1']} />);
      expect(screen.getByText(/set location for 1 item$/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Pin placement via map
  // -------------------------------------------------------------------------
  describe('Pin placement', () => {
    it('enables Apply button after a pin is set via the map', async () => {
      const user = userEvent.setup();
      render(<BulkLocationDialog {...defaultProps} />);

      await user.click(screen.getByTestId('set-pin'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /apply/i })).not.toBeDisabled();
      });
    });

    it('calls reverseGeocode after pin is set', async () => {
      const user = userEvent.setup();
      render(<BulkLocationDialog {...defaultProps} />);

      await user.click(screen.getByTestId('set-pin'));

      await waitFor(() => {
        expect(mockReverseGeocode).toHaveBeenCalledWith(9.9281, -84.0907);
      });
    });

    it('shows pin coordinates after pin is set', async () => {
      const user = userEvent.setup();
      render(<BulkLocationDialog {...defaultProps} />);

      await user.click(screen.getByTestId('set-pin'));

      await waitFor(() => {
        expect(screen.getByText(/pin:/i)).toBeInTheDocument();
      });
    });

    it('shows geocoded location label after reverse geocode', async () => {
      const user = userEvent.setup();
      render(<BulkLocationDialog {...defaultProps} />);

      await user.click(screen.getByTestId('set-pin'));

      await waitFor(() => {
        expect(screen.getByText(/La Fortuna/)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // handleApply
  // -------------------------------------------------------------------------
  describe('handleApply', () => {
    it('calls bulkUpdateMedia with pin location when Apply is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkLocationDialog {...defaultProps} />);

      await user.click(screen.getByTestId('set-pin'));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /apply/i })).not.toBeDisabled();
      });

      await user.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(mockBulkUpdateMedia).toHaveBeenCalledWith({
          circleId: 'circle-1',
          ids: ['item-1', 'item-2'],
          set: { location: { lat: 9.9281, lng: -84.0907 } },
        });
      });
    });

    it('calls onSuccess after successful apply', async () => {
      const user = userEvent.setup();
      render(<BulkLocationDialog {...defaultProps} />);

      await user.click(screen.getByTestId('set-pin'));
      await waitFor(() => expect(screen.getByRole('button', { name: /apply/i })).not.toBeDisabled());

      await user.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/location set/i),
        );
      });
    });

    it('shows error when bulkUpdateMedia fails on apply', async () => {
      mockBulkUpdateMedia.mockRejectedValueOnce(new Error('Location error'));
      const user = userEvent.setup();
      render(<BulkLocationDialog {...defaultProps} />);

      await user.click(screen.getByTestId('set-pin'));
      await waitFor(() => expect(screen.getByRole('button', { name: /apply/i })).not.toBeDisabled());

      await user.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(screen.getByText(/location error/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // handleClearLocation
  // -------------------------------------------------------------------------
  describe('handleClearLocation', () => {
    it('calls bulkUpdateMedia with location: null when Clear Location is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkLocationDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /clear location/i }));

      await waitFor(() => {
        expect(mockBulkUpdateMedia).toHaveBeenCalledWith({
          circleId: 'circle-1',
          ids: ['item-1', 'item-2'],
          set: { location: null },
        });
      });
    });

    it('calls onSuccess after successful clear', async () => {
      const user = userEvent.setup();
      render(<BulkLocationDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /clear location/i }));

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/cleared location/i),
        );
      });
    });

    it('shows error when clear location fails', async () => {
      mockBulkUpdateMedia.mockRejectedValueOnce(new Error('Clear failed'));
      const user = userEvent.setup();
      render(<BulkLocationDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /clear location/i }));

      await waitFor(() => {
        expect(screen.getByText(/clear failed/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Cancel button
  // -------------------------------------------------------------------------
  describe('Cancel button', () => {
    it('calls onClose when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkLocationDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Place search
  // -------------------------------------------------------------------------
  describe('Place search', () => {
    it('renders the search field', () => {
      render(<BulkLocationDialog {...defaultProps} />);
      expect(screen.getByLabelText(/search place/i)).toBeInTheDocument();
    });

    it('does not call searchPlaces when input is fewer than 2 chars', async () => {
      const user = userEvent.setup();
      render(<BulkLocationDialog {...defaultProps} />);

      const input = screen.getByLabelText(/search place/i);
      await user.type(input, 'S');

      expect(mockSearchPlaces).not.toHaveBeenCalled();
    });

    it('calls searchPlaces after debounce when typing 3+ chars', async () => {
      mockSearchPlaces.mockResolvedValue([]);
      vi.useFakeTimers();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<BulkLocationDialog {...defaultProps} />);

      const input = screen.getByLabelText(/search place/i);
      await user.type(input, 'San');

      // Before debounce fires, searchPlaces should not be called
      expect(mockSearchPlaces).not.toHaveBeenCalled();

      // Advance timers past the 400ms debounce
      act(() => { vi.advanceTimersByTime(500); });

      await waitFor(() => {
        expect(mockSearchPlaces).toHaveBeenCalledWith('San', 8);
      });

      vi.useRealTimers();
    });

    it('shows a result option when searchPlaces returns data', async () => {
      mockSearchPlaces.mockResolvedValue([{ lat: 10, lng: 20, label: 'Test City' }]);
      vi.useFakeTimers();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<BulkLocationDialog {...defaultProps} />);

      const input = screen.getByLabelText(/search place/i);
      await user.type(input, 'Test');

      act(() => { vi.advanceTimersByTime(500); });

      await waitFor(() => {
        expect(screen.getByText('Test City')).toBeInTheDocument();
      });

      vi.useRealTimers();
    });

    it('shows Place search unavailable alert on 503 error', async () => {
      const { ApiError } = await import('../../../services/api');
      mockSearchPlaces.mockRejectedValue(new ApiError('Service Unavailable', 503));
      vi.useFakeTimers();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<BulkLocationDialog {...defaultProps} />);

      const input = screen.getByLabelText(/search place/i);
      await user.type(input, 'San');

      act(() => { vi.advanceTimersByTime(500); });

      await waitFor(() => {
        expect(screen.getByText(/place search unavailable/i)).toBeInTheDocument();
      });

      vi.useRealTimers();
    });

    it('re-enables search input when dialog closes and reopens', async () => {
      const { ApiError } = await import('../../../services/api');
      mockSearchPlaces.mockRejectedValue(new ApiError('Service Unavailable', 503));
      vi.useFakeTimers();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { rerender } = render(<BulkLocationDialog {...defaultProps} />);

      // Trigger 503 to disable search
      const input = screen.getByLabelText(/search place/i);
      await user.type(input, 'San');
      act(() => { vi.advanceTimersByTime(500); });
      await waitFor(() => {
        expect(screen.getByText(/place search unavailable/i)).toBeInTheDocument();
      });

      // Close dialog
      rerender(<BulkLocationDialog {...defaultProps} open={false} />);
      // Reopen dialog
      rerender(<BulkLocationDialog {...defaultProps} open={true} />);

      // Search input should be visible again (searchDisabled reset to false)
      expect(screen.getByLabelText(/search place/i)).toBeInTheDocument();

      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // Closed state
  // -------------------------------------------------------------------------
  describe('Dialog not open', () => {
    it('does not render content when open is false', () => {
      render(<BulkLocationDialog {...defaultProps} open={false} />);
      expect(screen.queryByText(/set location for/i)).not.toBeInTheDocument();
    });
  });
});

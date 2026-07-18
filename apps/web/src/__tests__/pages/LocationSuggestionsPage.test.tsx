/**
 * Unit tests for LocationSuggestionsPage.
 *
 * Mocking strategy:
 *   - useCircle and useLocationSuggestions are module-mocked directly
 *     (mirrors DuplicatesPage.test.tsx — reaching one level above the
 *     service layer rather than mocking services/locationSuggestions here).
 *   - LocationMiniMap and LocationPickerMap are mocked to lightweight stubs
 *     (avoids react-leaflet dependency), matching the pattern used in
 *     MediaDetailDrawer.test.tsx / BulkLocationDialog.test.tsx.
 *   - services/media's searchPlaces/reverseGeocode are mocked so the Adjust
 *     dialog (which renders inline on this page) never hits the network.
 *   - services/locationSuggestions's acceptLocationSuggestion is mocked
 *     directly since AdjustLocationDialog calls it without going through
 *     the useLocationSuggestions hook.
 *
 * Covers:
 *  - Guard: "Select a circle" alert when no active circle
 *  - Loading spinner / empty state / error alert
 *  - Confidence chip color and label (>=0.8 success, >=0.5 warning, else default)
 *  - Anchor summary text (two-anchor interpolated vs single-anchor estimate)
 *  - Speed warning: only when impliedSpeedKmh != null && >= 60
 *  - LocationMiniMap rendered per row with the suggestion's lat/lng
 *  - Confirm button calls accept(id) with no lat/lng args
 *  - Reject button calls reject(id)
 *  - Adjust dialog opens seeded at the suggestion's coords; accept-with-
 *    adjusted-coords path via the LocationPickerMap stub
 *  - Bulk "Accept all >= 80% confidence" flow: confirm dialog, bulkAccept call,
 *    toolbar button disabled states
 *  - Bulk-accept is ASYNC (issue #125): confirming shows a queued/background
 *    message rather than a synchronous "Accepted N" count, and the page polls
 *    the pending list on an interval afterward (fake timers)
 *  - Empty state text when items is empty
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../hooks/useLocationSuggestions', () => ({
  useLocationSuggestions: vi.fn(),
}));

vi.mock('../../components/media/LocationMiniMap', () => ({
  LocationMiniMap: ({ lat, lng }: { lat: number; lng: number }) => (
    <div data-testid="location-mini-map" data-lat={lat} data-lng={lng} />
  ),
}));

vi.mock('../../components/media/LocationPickerMap', () => ({
  LocationPickerMap: ({
    value,
    onChange,
  }: {
    value: { lat: number; lng: number } | null;
    onChange: (latlng: { lat: number; lng: number }) => void;
  }) => (
    <div
      data-testid="location-picker-map"
      data-lat={value?.lat}
      data-lng={value?.lng}
      onClick={() => onChange({ lat: 40.7128, lng: -74.006 })}
    />
  ),
}));

vi.mock('../../services/media', () => ({
  searchPlaces: vi.fn(),
  reverseGeocode: vi.fn(),
}));

vi.mock('../../services/locationSuggestions', async () => {
  const actual = await vi.importActual<typeof import('../../services/locationSuggestions')>(
    '../../services/locationSuggestions',
  );
  return {
    ...actual,
    acceptLocationSuggestion: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import LocationSuggestionsPage from '../../pages/LocationSuggestions/LocationSuggestionsPage';
import { useCircle } from '../../hooks/useCircle';
import { useLocationSuggestions } from '../../hooks/useLocationSuggestions';
import { searchPlaces, reverseGeocode } from '../../services/media';
import { acceptLocationSuggestion } from '../../services/locationSuggestions';
import type { LocationSuggestionSummary } from '../../services/locationSuggestions';

const mockUseCircle = vi.mocked(useCircle);
const mockUseLocationSuggestions = vi.mocked(useLocationSuggestions);
const mockSearchPlaces = vi.mocked(searchPlaces);
const mockReverseGeocode = vi.mocked(reverseGeocode);
const mockAcceptLocationSuggestion = vi.mocked(acceptLocationSuggestion);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CIRCLE_ID = 'circle-1';

function makeCircle(id = CIRCLE_ID) {
  return {
    id,
    name: 'Test Circle',
    description: null,
    ownerId: 'user-1',
    isPersonal: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeCircleContext(overrides: Partial<ReturnType<typeof useCircle>> = {}): ReturnType<typeof useCircle> {
  return {
    activeCircle: makeCircle(),
    activeCircleId: CIRCLE_ID,
    activeCircleRole: 'collaborator',
    circles: [makeCircle()],
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ReturnType<typeof useCircle>;
}

function makeLocationSuggestionsHook(
  overrides: Partial<ReturnType<typeof useLocationSuggestions>> = {},
): ReturnType<typeof useLocationSuggestions> {
  return {
    items: [],
    meta: null,
    isLoading: false,
    error: null,
    fetchSuggestions: vi.fn().mockResolvedValue(undefined),
    accept: vi.fn().mockResolvedValue({ id: 's-1', status: 'accepted', lat: 0, lng: 0, coordSource: 'inferred' }),
    reject: vi.fn().mockResolvedValue({ id: 's-1', status: 'rejected' }),
    revert: vi.fn().mockResolvedValue({ id: 's-1', status: 'reverted' }),
    bulkAccept: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'pending' }),
    actingIds: new Set<string>(),
    bulkAccepting: false,
    ...overrides,
  };
}

function makeSuggestion(overrides: Partial<LocationSuggestionSummary> = {}): LocationSuggestionSummary {
  return {
    id: 'suggestion-1',
    mediaItemId: 'media-1',
    status: 'pending',
    lat: 9.9281,
    lng: -84.0907,
    confidence: 0.85,
    method: 'interpolated',
    anchorBeforeId: 'anchor-before',
    anchorAfterId: 'anchor-after',
    gapBeforeSeconds: 300,
    gapAfterSeconds: 400,
    anchorDistanceKm: 0.5,
    impliedSpeedKmh: 10,
    capturedAt: '2026-06-15T14:32:00.000Z',
    cameraMake: 'Apple',
    cameraModel: 'iPhone 14',
    thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocationSuggestionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCircle.mockReturnValue(makeCircleContext());
    mockUseLocationSuggestions.mockReturnValue(makeLocationSuggestionsHook());
    mockSearchPlaces.mockResolvedValue([]);
    mockReverseGeocode.mockResolvedValue({
      country: 'Costa Rica',
      countryCode: 'CR',
      admin1: 'Alajuela',
      admin2: null,
      locality: 'La Fortuna',
      placeName: 'Arenal',
    });
    mockAcceptLocationSuggestion.mockResolvedValue({
      id: 'suggestion-1',
      status: 'accepted',
      lat: 9.9281,
      lng: -84.0907,
      coordSource: 'manual',
    });
  });

  describe('no active circle', () => {
    it('shows a select-a-circle alert', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircle: null, activeCircleId: null }));

      render(<LocationSuggestionsPage />);

      expect(screen.getByText(/select a circle to review location suggestions/i)).toBeInTheDocument();
    });
  });

  describe('with active circle', () => {
    it('renders the "Location Suggestions" heading', () => {
      render(<LocationSuggestionsPage />);

      expect(screen.getByText('Location Suggestions')).toBeInTheDocument();
    });

    it('shows a loading spinner while fetching', () => {
      mockUseLocationSuggestions.mockReturnValue(makeLocationSuggestionsHook({ isLoading: true }));

      render(<LocationSuggestionsPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows the empty state message when no suggestions are returned', () => {
      mockUseLocationSuggestions.mockReturnValue(makeLocationSuggestionsHook({ items: [] }));

      render(<LocationSuggestionsPage />);

      expect(screen.getByText(/no location suggestions to review/i)).toBeInTheDocument();
    });

    it('renders an error message when fetch fails', () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ error: 'Network error loading suggestions' }),
      );

      render(<LocationSuggestionsPage />);

      expect(screen.getByText('Network error loading suggestions')).toBeInTheDocument();
    });

    it('calls fetchSuggestions with status=pending on mount', () => {
      const fetchSuggestions = vi.fn().mockResolvedValue(undefined);
      mockUseLocationSuggestions.mockReturnValue(makeLocationSuggestionsHook({ fetchSuggestions }));

      render(<LocationSuggestionsPage />);

      expect(fetchSuggestions).toHaveBeenCalledWith(
        expect.objectContaining({ circleId: CIRCLE_ID, status: 'pending', page: 1 }),
      );
    });
  });

  describe('confidence chip', () => {
    it('renders a success-colored chip with rounded percentage for confidence >= 0.8', () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion({ confidence: 0.85 })] }),
      );

      render(<LocationSuggestionsPage />);

      const chip = screen.getByText('85% confidence');
      expect(chip).toBeInTheDocument();
      expect(chip.closest('.MuiChip-root')).toHaveClass('MuiChip-colorSuccess');
    });

    it('renders a warning-colored chip for confidence in [0.5, 0.8)', () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion({ confidence: 0.6 })] }),
      );

      render(<LocationSuggestionsPage />);

      const chip = screen.getByText('60% confidence');
      expect(chip.closest('.MuiChip-root')).toHaveClass('MuiChip-colorWarning');
    });

    it('renders a default-colored chip for confidence below 0.5', () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion({ confidence: 0.3 })] }),
      );

      render(<LocationSuggestionsPage />);

      const chip = screen.getByText('30% confidence');
      expect(chip.closest('.MuiChip-root')).toHaveClass('MuiChip-colorDefault');
    });
  });

  describe('anchor summary', () => {
    it('shows "Interpolated between 2 nearby photos" when both anchors are present', () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({
          items: [
            makeSuggestion({
              anchorBeforeId: 'a-before',
              anchorAfterId: 'a-after',
              gapBeforeSeconds: 300,
              gapAfterSeconds: 400,
              anchorDistanceKm: 0.42,
            }),
          ],
        }),
      );

      render(<LocationSuggestionsPage />);

      expect(screen.getByText(/interpolated between 2 nearby photos/i)).toBeInTheDocument();
      expect(screen.getByText(/anchors 0\.42 km apart/i)).toBeInTheDocument();
    });

    it('shows "Estimated from a single nearby photo" when only one anchor is present', () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({
          items: [
            makeSuggestion({
              anchorBeforeId: 'a-before',
              anchorAfterId: null,
              gapBeforeSeconds: 300,
              gapAfterSeconds: null,
              anchorDistanceKm: null,
              method: 'nearest',
            }),
          ],
        }),
      );

      render(<LocationSuggestionsPage />);

      expect(screen.getByText(/estimated from a single nearby photo/i)).toBeInTheDocument();
      expect(screen.getByText(/before/i)).toBeInTheDocument();
    });
  });

  describe('speed warning', () => {
    it('renders the speed warning when impliedSpeedKmh >= 60', () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion({ impliedSpeedKmh: 85 })] }),
      );

      render(<LocationSuggestionsPage />);

      expect(screen.getByText(/anchors imply ~85 km\/h/i)).toBeInTheDocument();
      expect(screen.getByText(/subject may have been traveling/i)).toBeInTheDocument();
    });

    it('does NOT render the speed warning when impliedSpeedKmh is below 60', () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion({ impliedSpeedKmh: 45 })] }),
      );

      render(<LocationSuggestionsPage />);

      expect(screen.queryByText(/km\/h/i)).not.toBeInTheDocument();
    });

    it('does NOT render the speed warning when impliedSpeedKmh is null', () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion({ impliedSpeedKmh: null })] }),
      );

      render(<LocationSuggestionsPage />);

      expect(screen.queryByText(/km\/h/i)).not.toBeInTheDocument();
    });
  });

  describe('LocationMiniMap', () => {
    it('renders a mini-map per row with the suggestion lat/lng', () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion({ lat: 48.8566, lng: 2.3522 })] }),
      );

      render(<LocationSuggestionsPage />);

      const map = screen.getByTestId('location-mini-map');
      expect(map.getAttribute('data-lat')).toBe('48.8566');
      expect(map.getAttribute('data-lng')).toBe('2.3522');
    });
  });

  describe('Confirm action', () => {
    it('calls accept(id) with no lat/lng arguments when Confirm is clicked', async () => {
      const accept = vi.fn().mockResolvedValue({ id: 's-1', status: 'accepted', lat: 0, lng: 0, coordSource: 'inferred' });
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion({ id: 'suggestion-1' })], accept }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /confirm/i }));

      await waitFor(() => {
        expect(accept).toHaveBeenCalledWith('suggestion-1');
      });
    });

    it('shows a success snackbar after a successful confirm', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /confirm/i }));

      await waitFor(() => {
        expect(screen.getByText('Location confirmed')).toBeInTheDocument();
      });
    });

    it('shows an error alert when accept rejects', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({
          items: [makeSuggestion()],
          accept: vi.fn().mockRejectedValue(new Error('Accept failed')),
        }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /confirm/i }));

      await waitFor(() => {
        expect(screen.getByText('Accept failed')).toBeInTheDocument();
      });
    });

    it('disables the Confirm button for the row while it is in actingIds', () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({
          items: [makeSuggestion({ id: 'suggestion-1' })],
          actingIds: new Set(['suggestion-1']),
        }),
      );

      render(<LocationSuggestionsPage />);

      expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
    });
  });

  describe('Reject action', () => {
    it('calls reject(id) when Reject is clicked', async () => {
      const reject = vi.fn().mockResolvedValue({ id: 's-1', status: 'rejected' });
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion({ id: 'suggestion-1' })], reject }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /reject/i }));

      await waitFor(() => {
        expect(reject).toHaveBeenCalledWith('suggestion-1');
      });
    });

    it('shows a success snackbar after a successful reject', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /reject/i }));

      await waitFor(() => {
        expect(screen.getByText('Suggestion rejected')).toBeInTheDocument();
      });
    });
  });

  describe('Adjust dialog', () => {
    it('opens the adjust dialog seeded at the suggestion coordinates', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion({ lat: 9.9281, lng: -84.0907 })] }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /adjust/i }));

      await waitFor(() => {
        expect(screen.getByText('Adjust suggested location')).toBeInTheDocument();
      });

      const map = screen.getByTestId('location-picker-map');
      expect(map.getAttribute('data-lat')).toBe('9.9281');
      expect(map.getAttribute('data-lng')).toBe('-84.0907');
    });

    it('confirms unmodified coordinates with "Location confirmed" message', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion({ id: 'suggestion-1', lat: 9.9281, lng: -84.0907 })] }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /adjust/i }));
      const dialog = await screen.findByRole('dialog');

      await user.click(within(dialog).getByRole('button', { name: /confirm location/i }));

      await waitFor(() => {
        expect(mockAcceptLocationSuggestion).toHaveBeenCalledWith('suggestion-1', 9.9281, -84.0907);
      });
      await waitFor(() => {
        expect(screen.getByText('Location confirmed')).toBeInTheDocument();
      });
    });

    it('moving the pin then confirming sends the adjusted coordinates and "with your adjustment" message', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion({ id: 'suggestion-1', lat: 9.9281, lng: -84.0907 })] }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /adjust/i }));
      const dialog = await screen.findByRole('dialog');

      // Simulate a pin move via the mocked LocationPickerMap stub's onClick
      await user.click(within(dialog).getByTestId('location-picker-map'));

      await user.click(within(dialog).getByRole('button', { name: /confirm location/i }));

      await waitFor(() => {
        expect(mockAcceptLocationSuggestion).toHaveBeenCalledWith('suggestion-1', 40.7128, -74.006);
      });
      await waitFor(() => {
        expect(screen.getByText('Location confirmed with your adjustment')).toBeInTheDocument();
      });
    });

    it('closes the dialog when Cancel is clicked without calling acceptLocationSuggestion', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /adjust/i }));
      const dialog = await screen.findByRole('dialog');

      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByText('Adjust suggested location')).not.toBeInTheDocument();
      });
      expect(mockAcceptLocationSuggestion).not.toHaveBeenCalled();
    });
  });

  describe('bulk accept flow', () => {
    it('toolbar button is disabled when there are no items', () => {
      mockUseLocationSuggestions.mockReturnValue(makeLocationSuggestionsHook({ items: [] }));

      render(<LocationSuggestionsPage />);

      expect(screen.getByRole('button', { name: /accept all.*confidence/i })).toBeDisabled();
    });

    it('toolbar button is disabled while bulkAccepting is true', () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()], bulkAccepting: true }),
      );

      render(<LocationSuggestionsPage />);

      expect(screen.getByRole('button', { name: /accept all.*confidence/i })).toBeDisabled();
    });

    it('toolbar button is enabled when items exist and not bulk-accepting', () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );

      render(<LocationSuggestionsPage />);

      expect(screen.getByRole('button', { name: /accept all.*confidence/i })).not.toBeDisabled();
    });

    it('opens a confirm dialog when the toolbar button is clicked', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /accept all.*confidence/i }));

      await waitFor(() => {
        expect(screen.getByText('Accept high-confidence suggestions')).toBeInTheDocument();
      });
    });

    it('calls bulkAccept(activeCircleId, 0.8) when "Accept all" is confirmed', async () => {
      const bulkAccept = vi.fn().mockResolvedValue({ accepted: 4 });
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()], bulkAccept }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /accept all.*confidence/i }));
      const dialog = await screen.findByRole('dialog');

      await user.click(within(dialog).getByRole('button', { name: /^accept all$/i }));

      await waitFor(() => {
        expect(bulkAccept).toHaveBeenCalledWith(CIRCLE_ID, 0.8);
      });
    });

    // Bulk-accept is asynchronous (issue #125): the backend enqueues a
    // `location_bulk_accept` job and returns { jobId, status } immediately —
    // there is no synchronous "accepted count" to report. The UI instead
    // shows a queued/background message and polls the pending list.
    it('shows a queued/background message (not an "Accepted N" count) after confirming bulk accept', async () => {
      const bulkAccept = vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'pending' });
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()], bulkAccept }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /accept all.*confidence/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^accept all$/i }));

      await waitFor(() => {
        expect(bulkAccept).toHaveBeenCalledWith(CIRCLE_ID, 0.8);
      });
      await waitFor(() => {
        expect(
          screen.getByText(/queued.*accepting high-confidence suggestions in the background/i),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText(/accepted \d+ suggestions?/i)).not.toBeInTheDocument();
    });

    it('polls the pending list on an interval after bulk accept is queued', async () => {
      vi.useFakeTimers();
      try {
        const fetchSuggestions = vi.fn().mockResolvedValue(undefined);
        const bulkAccept = vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'pending' });
        mockUseLocationSuggestions.mockReturnValue(
          makeLocationSuggestionsHook({ items: [makeSuggestion()], fetchSuggestions, bulkAccept }),
        );

        render(<LocationSuggestionsPage />);

        // Initial mount fetch.
        expect(fetchSuggestions).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: /accept all.*confidence/i }));
        // MUI Dialog mounts synchronously on `open` state change — avoid an
        // async findBy/waitFor here, which would stall waiting on real timers
        // that fake timers have replaced.
        const dialog = screen.getByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: /^accept all$/i }));

        // Flush the awaited bulkAccept() call and the state updates/refresh()
        // that follow it (advanceTimersByTimeAsync also drains microtasks).
        await vi.advanceTimersByTimeAsync(0);

        expect(bulkAccept).toHaveBeenCalledWith(CIRCLE_ID, 0.8);
        // startBulkPoll() issues an immediate refresh on top of the mount fetch.
        const callsAfterQueue = fetchSuggestions.mock.calls.length;
        expect(callsAfterQueue).toBeGreaterThanOrEqual(2);

        // Advance past two 4s poll ticks. The mocked hook's item count never
        // changes (it's a static mock), so each tick re-fetches (the
        // stall-break needs 3 unchanged ticks before it stops).
        await vi.advanceTimersByTimeAsync(4000);
        await vi.advanceTimersByTimeAsync(4000);

        expect(fetchSuggestions.mock.calls.length).toBeGreaterThan(callsAfterQueue);
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows an error alert when bulkAccept rejects', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({
          items: [makeSuggestion()],
          bulkAccept: vi.fn().mockRejectedValue(new Error('Bulk accept failed')),
        }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /accept all.*confidence/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^accept all$/i }));

      await waitFor(() => {
        expect(screen.getByText('Bulk accept failed')).toBeInTheDocument();
      });
    });
  });
});

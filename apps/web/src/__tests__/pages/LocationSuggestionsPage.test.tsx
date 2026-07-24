/**
 * Unit tests for LocationSuggestionsPage.
 *
 * Mocking strategy:
 *   - useCircle, usePermissions, useSystemSettings, and useLocationSuggestions
 *     are module-mocked directly (mirrors BurstsPage.test.tsx / DuplicatesPage.test.tsx
 *     — reaching one level above the service layer rather than mocking
 *     services/locationSuggestions here).
 *   - services/locationSuggestionRuns's startLocationAcceptRun /
 *     startLocationRejectRun are mocked directly since the bulk accept/reject
 *     flow now starts an async run (issue mirrors trash-empty-at-scale) rather
 *     than calling a synchronous bulkAccept on the hook.
 *   - react-router-dom's useNavigate is mocked so the post-start navigation to
 *     /location-suggestion-runs/:runId can be asserted.
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
 *  - Threshold: reads default from useSystemSettings' locationInference.bulkAcceptThreshold
 *    (falls back to 80 when unset), inline TextField overrides it, clamped 0-100
 *  - Admin-only gear icon linking to /admin/settings/location-inference
 *  - Bulk "Accept all >= N%" flow: confirm dialog, startLocationAcceptRun call,
 *    navigation to the new run page, toolbar button disabled states
 *  - Bulk "Reject all < N%" flow: confirm dialog, startLocationRejectRun call,
 *    navigation to the new run page
 *  - Error from starting a bulk run surfaces an action-error alert
 *  - Empty state text when items is empty
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

vi.mock('../../hooks/useLocationSuggestions', () => ({
  useLocationSuggestions: vi.fn(),
}));

vi.mock('../../services/locationSuggestionRuns', () => ({
  startLocationAcceptRun: vi.fn(),
  startLocationRejectRun: vi.fn(),
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

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import LocationSuggestionsPage from '../../pages/LocationSuggestions/LocationSuggestionsPage';
import { useCircle } from '../../hooks/useCircle';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { useLocationSuggestions } from '../../hooks/useLocationSuggestions';
import { startLocationAcceptRun, startLocationRejectRun } from '../../services/locationSuggestionRuns';
import { searchPlaces, reverseGeocode } from '../../services/media';
import { acceptLocationSuggestion } from '../../services/locationSuggestions';
import type { LocationSuggestionSummary } from '../../services/locationSuggestions';

const mockUseCircle = vi.mocked(useCircle);
const mockUsePermissions = vi.mocked(usePermissions);
const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockUseLocationSuggestions = vi.mocked(useLocationSuggestions);
const mockStartLocationAcceptRun = vi.mocked(startLocationAcceptRun);
const mockStartLocationRejectRun = vi.mocked(startLocationRejectRun);
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

function makePermissions(isAdmin = false) {
  return {
    permissions: new Set<string>(['media:read', 'media:write']),
    roles: new Set<string>(isAdmin ? ['admin'] : ['viewer']),
    hasPermission: vi.fn().mockReturnValue(true),
    hasAnyPermission: vi.fn().mockReturnValue(true),
    hasAllPermissions: vi.fn().mockReturnValue(true),
    hasRole: vi.fn().mockReturnValue(isAdmin),
    hasAnyRole: vi.fn().mockReturnValue(isAdmin),
    isAdmin,
  } as unknown as ReturnType<typeof usePermissions>;
}

function makeSystemSettingsHook(
  bulkAcceptThreshold: number | undefined = 80,
): ReturnType<typeof useSystemSettings> {
  return {
    settings: {
      ui: { allowUserThemeOverride: true },
      features: {},
      locationInference:
        bulkAcceptThreshold === undefined ? undefined : { bulkAcceptThreshold },
      updatedAt: new Date().toISOString(),
      updatedBy: null,
      version: 1,
    } as any,
    isLoading: false,
    isSaving: false,
    error: null,
    updateSettings: vi.fn().mockResolvedValue(undefined),
    replaceSettings: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
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
    actingIds: new Set<string>(),
    ...overrides,
  } as unknown as ReturnType<typeof useLocationSuggestions>;
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
    mockUsePermissions.mockReturnValue(makePermissions(false));
    mockUseSystemSettings.mockReturnValue(makeSystemSettingsHook());
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
    mockStartLocationAcceptRun.mockResolvedValue({
      runId: 'run-1',
      status: 'evaluating',
      matchedCount: 0,
    });
    mockStartLocationRejectRun.mockResolvedValue({
      runId: 'run-2',
      status: 'evaluating',
      matchedCount: 0,
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

      await user.click(screen.getByRole('button', { name: /^reject$/i }));

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

      await user.click(screen.getByRole('button', { name: /^reject$/i }));

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

  describe('threshold default from system settings', () => {
    it('uses locationInference.bulkAcceptThreshold from system settings for both toolbar buttons', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsHook(65));
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );

      render(<LocationSuggestionsPage />);

      expect(screen.getByRole('button', { name: /accept all.*65%/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reject all.*65%/i })).toBeInTheDocument();
    });

    it('falls back to a threshold of 80 when locationInference.bulkAcceptThreshold is unset', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettingsHook(undefined));
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );

      render(<LocationSuggestionsPage />);

      expect(screen.getByRole('button', { name: /accept all.*80%/i })).toBeInTheDocument();
    });

    it('the inline Threshold % field overrides the confirm-dialog wording', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      const field = screen.getByLabelText(/threshold %/i);
      await user.clear(field);
      await user.type(field, '55');

      expect(screen.getByRole('button', { name: /accept all.*55%/i })).toBeInTheDocument();
    });
  });

  describe('admin-only location inference settings gear icon', () => {
    it('renders the gear icon linking to /admin/settings/location-inference for an admin', () => {
      mockUsePermissions.mockReturnValue(makePermissions(true));

      render(<LocationSuggestionsPage />);

      const gear = screen.getByRole('link', { name: /location inference settings/i });
      expect(gear).toBeInTheDocument();
      expect(gear).toHaveAttribute('href', '/admin/settings/location-inference');
    });

    it('does not render the gear icon for a non-admin', () => {
      mockUsePermissions.mockReturnValue(makePermissions(false));

      render(<LocationSuggestionsPage />);

      expect(screen.queryByRole('link', { name: /location inference settings/i })).toBeNull();
    });
  });

  describe('bulk accept run flow', () => {
    it('the "Accept all" toolbar button is disabled when there are no items', () => {
      mockUseLocationSuggestions.mockReturnValue(makeLocationSuggestionsHook({ items: [] }));

      render(<LocationSuggestionsPage />);

      expect(screen.getByRole('button', { name: /accept all.*80%/i })).toBeDisabled();
    });

    it('the "Reject all" toolbar button is disabled when there are no items', () => {
      mockUseLocationSuggestions.mockReturnValue(makeLocationSuggestionsHook({ items: [] }));

      render(<LocationSuggestionsPage />);

      expect(screen.getByRole('button', { name: /reject all.*80%/i })).toBeDisabled();
    });

    it('opens a confirm dialog when "Accept all" is clicked', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /accept all.*80%/i }));

      await waitFor(() => {
        expect(screen.getByText('Accept suggestions ≥ 80%?')).toBeInTheDocument();
      });
    });

    it('confirming "Accept all" calls startLocationAcceptRun({ circleId, threshold }) and navigates to the run page', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );
      mockStartLocationAcceptRun.mockResolvedValue({
        runId: 'run-accept-1',
        status: 'evaluating',
        matchedCount: 0,
      });
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /accept all.*80%/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^accept all$/i }));

      await waitFor(() => {
        expect(mockStartLocationAcceptRun).toHaveBeenCalledWith({ circleId: CIRCLE_ID, threshold: 80 });
      });
      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/location-suggestion-runs/run-accept-1');
      });
    });

    it('opens a confirm dialog when "Reject all" is clicked', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /reject all.*80%/i }));

      await waitFor(() => {
        expect(screen.getByText('Reject suggestions below 80%?')).toBeInTheDocument();
      });
    });

    it('confirming "Reject all" calls startLocationRejectRun({ circleId, threshold }) and navigates to the run page', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );
      mockStartLocationRejectRun.mockResolvedValue({
        runId: 'run-reject-1',
        status: 'evaluating',
        matchedCount: 0,
      });
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /reject all.*80%/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^reject all$/i }));

      await waitFor(() => {
        expect(mockStartLocationRejectRun).toHaveBeenCalledWith({ circleId: CIRCLE_ID, threshold: 80 });
      });
      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/location-suggestion-runs/run-reject-1');
      });
    });

    it('shows an action-error alert and does not navigate when startLocationAcceptRun rejects (e.g. 409 already in progress)', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );
      mockStartLocationAcceptRun.mockRejectedValue(
        new Error('A location-suggestion run is already in progress for this circle'),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /accept all.*80%/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^accept all$/i }));

      await waitFor(() => {
        expect(
          screen.getByText('A location-suggestion run is already in progress for this circle'),
        ).toBeInTheDocument();
      });
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('shows an action-error alert when startLocationRejectRun rejects', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );
      mockStartLocationRejectRun.mockRejectedValue(new Error('Failed to start run'));
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /reject all.*80%/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^reject all$/i }));

      await waitFor(() => {
        expect(screen.getByText('Failed to start run')).toBeInTheDocument();
      });
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('closing the confirm dialog without confirming does not start a run', async () => {
      mockUseLocationSuggestions.mockReturnValue(
        makeLocationSuggestionsHook({ items: [makeSuggestion()] }),
      );
      const user = userEvent.setup();

      render(<LocationSuggestionsPage />);

      await user.click(screen.getByRole('button', { name: /accept all.*80%/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

      await waitFor(() => {
        expect(screen.queryByText('Accept suggestions ≥ 80%?')).not.toBeInTheDocument();
      });
      expect(mockStartLocationAcceptRun).not.toHaveBeenCalled();
    });
  });
});

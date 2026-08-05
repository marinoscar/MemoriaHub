/**
 * Component tests — HomePage
 *
 * HomePage is a minimal page that:
 *   - Shows a "Select or create a circle" alert when no circle is active
 *   - Renders <MediaGallery> in feed mode when a circle is active
 *
 * The Upload button moved to the AppBar (global); HomePage no longer owns
 * an Upload FAB or MediaUploadDialog.  Tests that previously asserted on
 * those elements have been removed.
 *
 * The three review-queue banners (pending bursts / duplicates / location
 * suggestions) and their `useDashboard` mock were removed in issue #250, the
 * Notification Center cutover: those counts are now delivered as notifications
 * (bell + `/notifications`), and HomePage no longer calls `useDashboard` at
 * all. The banner tests are gone rather than inverted — there is nothing left
 * on this page for them to assert against.
 *
 * MediaGallery is mocked to isolate HomePage chrome tests from gallery
 * internals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render, mockUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

// Mock MediaGallery so its internal useInfiniteMedia / listMedia calls never fire.
vi.mock('../../components/media/MediaGallery', () => ({
  MediaGallery: vi.fn(({ emptyState }: { emptyState?: React.ReactNode }) => (
    <div data-testid="media-gallery">{emptyState}</div>
  )),
}));

// REGRESSION GUARD (issue #250): `useDashboard` is mocked here even though
// HomePage no longer imports it. The mock resolves with counts that WOULD
// render all three review-queue banners if the removed JSX were ever
// reintroduced — so this is a real trap, not just "the banners aren't here
// today because nothing fetches them". If a future change re-adds the
// `useDashboard()` call and the banner JSX, this mock feeds it non-zero
// counts and the "banners removed" assertions below start failing.
vi.mock('../../hooks/useDashboard', () => ({
  useDashboard: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import HomePage from '../../pages/HomePage';
import { useCircle } from '../../hooks/useCircle';
import { useDashboard } from '../../hooks/useDashboard';

const mockUseCircle = vi.mocked(useCircle);
const mockUseDashboard = vi.mocked(useDashboard);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const defaultActiveCircle = {
  id: 'circle-1',
  name: "Test User's Library",
  isPersonal: true,
  ownerId: 'test-user-id',
  description: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function setupActiveCircle() {
  mockUseCircle.mockReturnValue({
    circles: [defaultActiveCircle],
    activeCircle: defaultActiveCircle,
    activeCircleId: 'circle-1',
    activeCircleRole: 'circle_admin',
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
  });
}

function setupNoCircle() {
  mockUseCircle.mockReturnValue({
    circles: [],
    activeCircle: null,
    activeCircleId: null,
    activeCircleRole: null,
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
  });
}

function setupCircleLoading() {
  mockUseCircle.mockReturnValue({
    circles: [],
    activeCircle: null,
    activeCircleId: null,
    activeCircleRole: null,
    loading: true,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Non-zero on every count, and on every level (0/1/plural), so that a
    // reintroduced banner would render regardless of which count triggered it
    // or which singular/plural label branch it hit. See the module mock above.
    mockUseDashboard.mockReturnValue({
      data: {
        onThisDay: [],
        recent: [],
        favorites: [],
        counts: {
          total: 10,
          missingGeo: 0,
          pendingBurstGroups: 2,
          pendingDuplicateGroups: 4,
          pendingLocationSuggestions: 7,
          pendingEnhancements: 3,
        },
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  // -------------------------------------------------------------------------
  // a) No active circle
  // -------------------------------------------------------------------------
  describe('No active circle', () => {
    it('shows "Select or create a circle" alert when no circle is active', () => {
      setupNoCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(
        screen.getByText(/select or create a circle to get started/i),
      ).toBeInTheDocument();
    });

    it('does NOT render MediaGallery when no circle is active', () => {
      setupNoCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.queryByTestId('media-gallery')).not.toBeInTheDocument();
    });

    it('does NOT show no-circle alert when circle is loading', () => {
      setupCircleLoading();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // While loading, neither alert nor gallery is shown
      expect(
        screen.queryByText(/select or create a circle/i),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // b) Active circle — gallery and FAB
  // -------------------------------------------------------------------------
  describe('Active circle', () => {
    it('renders MediaGallery when a circle is active', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByTestId('media-gallery')).toBeInTheDocument();
    });

    it('does NOT show the no-circle alert when a circle is active', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(
        screen.queryByText(/select or create a circle to get started/i),
      ).not.toBeInTheDocument();
    });

  });

  // -------------------------------------------------------------------------
  // c) Empty state inside MediaGallery
  // -------------------------------------------------------------------------
  describe('Empty state', () => {
    it('passes an emptyState prop to MediaGallery that includes "No photos here yet"', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // The mock renders children (emptyState) inside the data-testid element.
      expect(screen.getByText(/no photos here yet/i)).toBeInTheDocument();
    });

    it('mentions the Upload button in the toolbar in the empty state text', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // Empty state now refers to "Upload button in the toolbar" (moved to AppBar)
      expect(screen.getByText(/upload button in the toolbar/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // d) "Go to Circles" link in no-circle alert
  // -------------------------------------------------------------------------
  describe('Go to Circles link', () => {
    it('renders a "Go to Circles" link in the no-circle alert', () => {
      setupNoCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByRole('link', { name: /go to circles/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // e) Review-queue banners removed (issue #250, epic #240) — REGRESSION GUARD
  //
  // The point of this block is not "the banners aren't on the page" (trivially
  // true of any page that renders nothing extra) — it's that reintroducing the
  // deleted `useDashboard()` call and banner JSX would be CAUGHT here. The
  // `useDashboard` mock (see module mocks above) is wired to resolve with
  // non-zero pendingBurstGroups/pendingDuplicateGroups/pendingLocationSuggestions
  // on every render in this file, precisely so that IF the removed code came
  // back, these assertions would start failing instead of staying vacuously
  // green. All cases run with an ACTIVE circle — the banners' rendering
  // condition (per the deleted code) never depended on `showNoCircle`.
  // -------------------------------------------------------------------------
  describe('Review-queue banners removed (issue #250)', () => {
    it('does not call useDashboard at all', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(mockUseDashboard).not.toHaveBeenCalled();
    });

    it('does not render the pending burst groups banner', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.queryByText(/burst group.*ready to review/i)).not.toBeInTheDocument();
    });

    it('does not render the pending duplicate groups banner', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.queryByText(/duplicate group.*ready to review/i)).not.toBeInTheDocument();
    });

    it('does not render the pending location suggestions banner', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(
        screen.queryByText(/location suggestion.*ready to review/i),
      ).not.toBeInTheDocument();
    });

    it('does not render the banners\' shared "Review" call-to-action button', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.queryByRole('button', { name: /^review$/i })).not.toBeInTheDocument();
    });

    it('renders only the gallery and the empty-state copy — no banner Alert beside it', () => {
      setupActiveCircle();
      const { container } = render(<HomePage />, {
        wrapperOptions: { authenticated: true, user: mockUser },
      });

      // Exactly the gallery mock's own wrapper; the deleted banners each
      // rendered their own MUI <Alert severity="info">, which would add
      // `.MuiAlert-root` siblings here (the no-circle alert is not present
      // because a circle is active in this scenario).
      expect(container.querySelectorAll('.MuiAlert-root')).toHaveLength(0);
      expect(screen.getByTestId('media-gallery')).toBeInTheDocument();
    });
  });

});

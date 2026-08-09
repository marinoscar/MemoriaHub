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

// The memories carousel owns its own feature-flag gating and feed request;
// mocking it keeps this file's assertions about HomePage chrome isolated from
// both. Its default mock renders nothing, matching the flag-off default.
vi.mock('../../components/memories/MemoriesCarousel', () => ({
  MemoriesCarousel: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import HomePage from '../../pages/HomePage';
import { useCircle } from '../../hooks/useCircle';
import { MemoriesCarousel } from '../../components/memories/MemoriesCarousel';

const mockUseCircle = vi.mocked(useCircle);
const mockMemoriesCarousel = vi.mocked(MemoriesCarousel);

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
    mockMemoriesCarousel.mockReturnValue(null);
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
  // The banners' `useDashboard()` source was deleted outright in issue #309, so
  // the strongest guard against their return is now the compiler: there is no
  // module left to import. These assertions cover the rendered shape — that no
  // Alert-bearing banner sits beside the gallery — which is what a hand-rolled
  // reintroduction (fetching the counts some other way) would still trip. All
  // cases run with an ACTIVE circle, since the banners' rendering condition
  // never depended on `showNoCircle`.
  // -------------------------------------------------------------------------
  describe('Review-queue banners removed (issue #250)', () => {
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

  // -------------------------------------------------------------------------
  // f) Memories carousel (issue #309, epic #300)
  //
  // HomePage's only job here is to MOUNT the row and hand it the active
  // circle — every gating decision (flag off, empty feed) belongs to the
  // carousel and is covered by its own suite. The second case is the one that
  // matters for "Home is pixel-identical on a new install": a carousel that
  // renders null must leave nothing behind on the page.
  // -------------------------------------------------------------------------
  describe('Memories carousel', () => {
    it('mounts the carousel with the active circle id', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(mockMemoriesCarousel).toHaveBeenCalled();
      expect(mockMemoriesCarousel.mock.calls[0][0]).toMatchObject({
        circleId: 'circle-1',
      });
    });

    it('adds nothing to the page when the carousel renders null', () => {
      setupActiveCircle();
      const { container } = render(<HomePage />, {
        wrapperOptions: { authenticated: true, user: mockUser },
      });

      expect(container.querySelectorAll('section')).toHaveLength(0);
      expect(screen.getByTestId('media-gallery')).toBeInTheDocument();
    });
  });

});

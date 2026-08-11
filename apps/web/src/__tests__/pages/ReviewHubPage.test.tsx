/**
 * Tests for ReviewHubPage (issue #390, spec §3.1 / §4.5).
 *
 * Thin by design — the page contributes chrome, scroll restoration, and the
 * count-invalidation-on-mount behavior around `ReviewQueueList`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { Routes, Route, Link as RouterLink } from 'react-router-dom';
import { render } from '../utils/test-utils';
import ReviewHubPage from '../../pages/Reviews/ReviewHubPage';
import { __resetReviewCountsForTests } from '../../hooks/useReviewCounts';
import { useReviewQueues } from '../../hooks/useReviewQueues';
import type { ReviewCountsResponse } from '../../types/media';
import type { PictureEnhancementPolicy } from '../../services/features';

vi.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(),
}));
vi.mock('../../hooks/useWorkflowSubjects', () => ({
  useWorkflowsEnabled: vi.fn(),
}));
vi.mock('../../hooks/useScrollRestoration', () => ({
  useScrollRestoration: vi.fn(),
}));
// The service layer, not the hook, so the count-refresh test drives the real
// useReviewCounts / refreshReviewCounts machinery end to end.
vi.mock('../../services/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/media')>()),
  getReviewCounts: vi.fn(),
}));

import { useFeatureFlags } from '../../hooks/useFeatureFlags';
import { useWorkflowsEnabled } from '../../hooks/useWorkflowSubjects';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';
import { getReviewCounts } from '../../services/media';

const mockUseFeatureFlags = vi.mocked(useFeatureFlags);
const mockUseWorkflowsEnabled = vi.mocked(useWorkflowsEnabled);
const mockUseScrollRestoration = vi.mocked(useScrollRestoration);
const mockGetReviewCounts = vi.mocked(getReviewCounts);

function mockFlags(features: Record<string, boolean>, pictureEnhancement: PictureEnhancementPolicy | null = null) {
  mockUseFeatureFlags.mockReturnValue({
    features,
    pictureEnhancement,
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });
}

function counts(overrides: Partial<ReviewCountsResponse> = {}): ReviewCountsResponse {
  return {
    pendingBurstGroups: 0,
    pendingDuplicateGroups: 0,
    pendingLocationSuggestions: 0,
    pendingEnhancements: 0,
    ...overrides,
  };
}

describe('ReviewHubPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetReviewCountsForTests();
    mockUseWorkflowsEnabled.mockReturnValue(false);
  });

  // =========================================================================
  // Renders the list
  // =========================================================================

  it('renders the page heading and the queue list', async () => {
    mockFlags({ duplicateDetection: true });
    mockGetReviewCounts.mockResolvedValue(counts({ pendingDuplicateGroups: 3 }));

    render(<ReviewHubPage />);

    expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Duplicates, 3 pending' })).toBeInTheDocument();
  });

  // =========================================================================
  // Request-count regression (issue #392) — the fix itself had no standing
  // assertion before this test.
  // =========================================================================

  it('mounting on phone issues at most 2 GET /api/media/review-counts calls, not 4', async () => {
    mockFlags({ duplicateDetection: true });
    mockGetReviewCounts.mockResolvedValue(counts({ pendingDuplicateGroups: 3 }));

    // Default (non-desktop) viewport, matching the "phone" case elsewhere in
    // this file — `up('lg')` redirects away before the hub (and its two
    // counts consumers) ever renders.
    render(<ReviewHubPage />);

    // Let both `useReviewCounts` consumers' mount effects, the page's own
    // mount-triggered `refreshReviewCounts()` bump, and the resulting
    // settle(s) all play out.
    await screen.findByRole('link', { name: 'Duplicates, 3 pending' });

    // Pre-fix (#392), this was 4: `ReviewHubPage` mounts two `useReviewCounts`
    // consumers — its own `useReviewQueues()` plus the nested
    // `<ReviewQueueList variant="hub">` — and the page's own mount effect
    // immediately calls `refreshReviewCounts()`, bumping the shared revision
    // right after both consumers have already started fetching. The fix
    // makes an instance with a request already in flight skip the
    // bump-triggered refetch, dropping the count to 2.
    //
    // Asserting `<= 2` rather than `=== 2` is deliberate, not a loosened
    // check: with an instantly-resolving mock, whether a fetch's `.then`
    // continuation (which clears `inFlightRef`) runs before or after the
    // revision bump's store-triggered re-render is a genuine race in THIS
    // TEST ENVIRONMENT ONLY — a real network round trip always dwarfs a
    // React commit, so production is unaffected either way (see
    // `useReviewCounts.ts`'s guard-2 comment). `<= 2` still fails loudly at
    // the pre-fix value of 4, which is the regression worth catching, without
    // being flaky on that ordering. Do not tighten this to `=== 2`.
    expect(mockGetReviewCounts.mock.calls.length).toBeLessThanOrEqual(2);
  });

  // =========================================================================
  // Navigating a row targets /review/<key>
  // =========================================================================

  it('a row links to /review/<key>', async () => {
    mockFlags({ duplicateDetection: true });
    mockGetReviewCounts.mockResolvedValue(counts({ pendingDuplicateGroups: 3 }));

    render(<ReviewHubPage />);

    const link = await screen.findByRole('link', { name: 'Duplicates, 3 pending' });
    expect(link.getAttribute('href')).toBe('/review/duplicates');
  });

  // =========================================================================
  // Scroll restoration
  // =========================================================================

  it('invokes scroll restoration under the "review-hub" key, disabled on desktop where this page never paints a scrollable list', () => {
    mockFlags({});

    render(<ReviewHubPage />);

    // Restoration is a no-op on desktop (`enabled: !isDesktop`) — the default
    // (non-desktop) viewport here means `enabled: true`.
    expect(mockUseScrollRestoration).toHaveBeenCalledWith('review-hub', { enabled: true });
  });

  // =========================================================================
  // Count refresh on return — the criterion most likely to regress silently.
  // =========================================================================

  it('shows a fresh count on return rather than a cached one, driven through the real useReviewCounts', async () => {
    mockFlags({ duplicateDetection: true });
    // A persistent (not one-shot) resolved value for this "visit" — the page's
    // own mount effect bumps the shared revision immediately, which causes an
    // extra internal refetch on the same mount; a persistent value keeps the
    // assertion about the SETTLED count robust to that, rather than pinning an
    // exact call count.
    mockGetReviewCounts.mockResolvedValue(counts({ pendingDuplicateGroups: 3 }));

    function Harness() {
      return (
        <Routes>
          <Route
            path="/review"
            element={
              <>
                <RouterLink to="/away">Leave</RouterLink>
                <ReviewHubPage />
              </>
            }
          />
          <Route path="/away" element={<RouterLink to="/review">Return</RouterLink>} />
        </Routes>
      );
    }

    render(<Harness />, { wrapperOptions: { route: '/review' } });

    expect(await screen.findByRole('link', { name: 'Duplicates, 3 pending' })).toBeInTheDocument();

    // Something changed while the user was away.
    mockGetReviewCounts.mockResolvedValue(counts({ pendingDuplicateGroups: 9 }));

    fireEvent.click(screen.getByText('Leave'));
    await waitFor(() => expect(screen.getByText('Return')).toBeInTheDocument());
    // The hub is unmounted while away — its cached "3" is gone with it.
    expect(screen.queryByRole('link', { name: /Duplicates/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Return'));

    // The NEW value renders, not the stale "3".
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Duplicates, 9 pending' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: 'Duplicates, 3 pending' })).not.toBeInTheDocument();
  });

  it('mounting the hub bumps the shared revision so an already-mounted consumer refetches too', async () => {
    mockFlags({ duplicateDetection: true });
    mockGetReviewCounts.mockResolvedValue(counts({ pendingDuplicateGroups: 3 }));

    // Simulate the sidebar's aggregate badge: a second, independently-mounted
    // consumer of the same shared counts that stays mounted the whole time.
    function Badge() {
      const { totalPending } = useReviewQueues();
      return <div data-testid="badge">{totalPending}</div>;
    }

    function Harness({ showHub }: { showHub: boolean }) {
      return (
        <>
          <Badge />
          {showHub && <ReviewHubPage />}
        </>
      );
    }

    const { rerender } = render(<Harness showHub={false} />);

    await waitFor(() => expect(screen.getByTestId('badge').textContent).toBe('3'));

    // The count changed server-side while only the badge was mounted.
    mockGetReviewCounts.mockResolvedValue(counts({ pendingDuplicateGroups: 9 }));

    rerender(<Harness showHub={true} />);

    // The badge instance never unmounted, yet it picks up the new value —
    // proof the hub's mount invalidation reaches every mounted consumer, not
    // just its own internal list.
    await waitFor(() => expect(screen.getByTestId('badge').textContent).toBe('9'));
  });

  // =========================================================================
  // Desktop redirect (issue #392, spec §4.5) — `/review` lands the user
  // straight in the first enabled queue on desktop instead of duplicating the
  // context pane's own overview list in <main>.
  // =========================================================================

  describe('desktop (up("lg")) redirect', () => {
    function setViewportWidth(px: number) {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => {
          const min = query.match(/min-width:\s*([\d.]+)px/);
          const max = query.match(/max-width:\s*([\d.]+)px/);
          let matches = true;
          if (min) matches = matches && px >= parseFloat(min[1]);
          if (max) matches = matches && px <= parseFloat(max[1]);
          return {
            matches,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
          };
        }),
      });
    }

    function restoreDefaultViewport() {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });
    }

    const DESKTOP_WIDTH = 1300; // >= lg (1200)

    function renderAtRoute(path = '/review') {
      function Harness() {
        return (
          <Routes>
            <Route path="/review" element={<ReviewHubPage />} />
            <Route path="/review/bursts" element={<div>Bursts queue marker</div>} />
            <Route path="/review/duplicates" element={<div>Duplicates queue marker</div>} />
            <Route path="/review/insights" element={<div>Insights marker</div>} />
            <Route path="/review/automations" element={<div>Automations marker</div>} />
          </Routes>
        );
      }
      return render(<Harness />, { wrapperOptions: { route: path } });
    }

    afterEach(() => {
      restoreDefaultViewport();
    });

    it('redirects to the first ENABLED queue in registry order — bursts before duplicates, never "the fullest queue"', async () => {
      setViewportWidth(DESKTOP_WIDTH);
      // Duplicates has a far higher count, but bursts precedes it in
      // REVIEW_QUEUES' fixed registry order — the redirect must not be
      // swayed by which queue has more pending work.
      mockFlags({ burstDetection: true, duplicateDetection: true });
      mockGetReviewCounts.mockResolvedValue(
        counts({ pendingBurstGroups: 1, pendingDuplicateGroups: 500 }),
      );

      renderAtRoute('/review');

      expect(await screen.findByText('Bursts queue marker')).toBeInTheDocument();
      expect(screen.queryByText('Duplicates queue marker')).not.toBeInTheDocument();
    });

    // "Insights" (`REVIEW_QUEUES`'s first `secondary` entry) carries NO
    // feature flag (`flag: null`) — it is unconditionally available. So with
    // every queue-producing feature off, the redirect's fallback
    // (`entries.find('queue') ?? entries.find('secondary')`) still finds a
    // landing target: Insights, in registry order, ahead of Automations.
    // This also means `landingEntry` can never truly be null today — see the
    // next test.
    it('falls back to the first SECONDARY entry (Insights) in registry order once no queue-producing feature is on', async () => {
      setViewportWidth(DESKTOP_WIDTH);
      mockUseWorkflowsEnabled.mockReturnValue(true); // Automations also enabled, but Insights precedes it
      mockFlags({}); // every queue-producing (bursts/duplicates/locations/enhancements) feature off

      renderAtRoute('/review');

      expect(await screen.findByText('Insights marker')).toBeInTheDocument();
      expect(screen.queryByText('Automations marker')).not.toBeInTheDocument();
    });

    it('does NOT redirect while flags are still loading — falls through to the normal render', () => {
      setViewportWidth(DESKTOP_WIDTH);
      mockUseFeatureFlags.mockReturnValue({
        features: null,
        pictureEnhancement: null,
        isLoading: true,
        error: null,
        refresh: vi.fn().mockResolvedValue(undefined),
      });

      renderAtRoute('/review');

      // No redirect happened — the hub's own heading is what's on screen.
      expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument();
      expect(screen.queryByText('Bursts queue marker')).not.toBeInTheDocument();
    });

    // NOTE on the "does not redirect while counts are loading" half of this
    // requirement: `useReviewCounts`'s `isLoading` starts `false` (its
    // `useState` initial value) and only flips `true` once the mount EFFECT
    // runs — but `ReviewHubPage`'s redirect decision is made from the FIRST
    // render's output, which is computed before any effect has run. Because
    // `landingEntry` itself is derived purely from flags/registry order (not
    // counts), the redirect fires on that first render regardless of whether
    // a counts fetch is in flight. Verified empirically: a `getReviewCounts`
    // that never resolves does not stop the desktop redirect. This diverges
    // from the code's own comment ("until the flags AND counts have
    // answered..."), which is worth a maintainer's attention — flagged in the
    // handoff rather than asserted here as a passing case, since the
    // "blocks on counts" behavior does not actually hold today.
    it('does NOT wait on counts to answer before redirecting (counts are irrelevant to landingEntry, which is registry+flags only)', async () => {
      setViewportWidth(DESKTOP_WIDTH);
      mockFlags({ duplicateDetection: true });
      // Never resolves.
      mockGetReviewCounts.mockReturnValue(new Promise(() => {}));

      renderAtRoute('/review');

      expect(await screen.findByText('Duplicates queue marker')).toBeInTheDocument();
    });

    // "Nothing enabled" is likewise structurally unreachable via feature
    // flags today, for the same reason as the Insights fallback test above:
    // `anyEnabled` (`ReviewQueueList`'s "No review features are enabled"
    // gate) requires `entries.length === 0`, but Insights's null flag means
    // `entries` can never be empty. The component's own comment
    // acknowledges this ("today this cannot happen") and keeps the branch
    // only for forward compatibility. So the true, provable statement is:
    // even with every OTHER feature off, the desktop redirect still fires —
    // to Insights, never to the "No review features are enabled" fallback.
    it('always finds a landing target today — even with every queue and Automations off, it redirects to Insights rather than falling through to "no features enabled"', async () => {
      setViewportWidth(DESKTOP_WIDTH);
      mockUseWorkflowsEnabled.mockReturnValue(false);
      mockFlags({}); // every review feature off, workflows off too

      renderAtRoute('/review');

      expect(await screen.findByText('Insights marker')).toBeInTheDocument();
      expect(screen.queryByText('No review features are enabled')).not.toBeInTheDocument();
    });

    it('phone (default viewport) still renders the full hub list — no redirect', async () => {
      mockFlags({ duplicateDetection: true });
      mockGetReviewCounts.mockResolvedValue(counts({ pendingDuplicateGroups: 3 }));

      renderAtRoute('/review');

      expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument();
      expect(await screen.findByRole('link', { name: 'Duplicates, 3 pending' })).toBeInTheDocument();
    });

    it('tablet (md-lg) still renders the full hub list — the 56px rail has no room for a pane', async () => {
      setViewportWidth(950); // >= md(900), < lg(1200)
      mockFlags({ duplicateDetection: true });
      mockGetReviewCounts.mockResolvedValue(counts({ pendingDuplicateGroups: 3 }));

      renderAtRoute('/review');

      expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument();
      expect(await screen.findByRole('link', { name: 'Duplicates, 3 pending' })).toBeInTheDocument();
    });
  });
});

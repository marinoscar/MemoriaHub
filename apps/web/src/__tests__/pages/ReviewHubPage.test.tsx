/**
 * Tests for ReviewHubPage (issue #390, spec §3.1 / §4.5).
 *
 * Thin by design — the page contributes chrome, scroll restoration, and the
 * count-invalidation-on-mount behavior around `ReviewQueueList`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('invokes scroll restoration under the "review-hub" key', () => {
    mockFlags({});

    render(<ReviewHubPage />);

    expect(mockUseScrollRestoration).toHaveBeenCalledWith('review-hub');
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
});

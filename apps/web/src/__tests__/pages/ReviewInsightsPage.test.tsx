/**
 * Render tests for ReviewInsightsPage.
 *
 * Covers:
 *   - "Select a circle" prompt when there is no active circle
 *   - Loading state: KpiSkeleton rendered while loading
 *   - Error state: error Alert shown
 *   - Empty state: "No review activity yet" when both bursts.identified and
 *     duplicates.identified are 0
 *   - Loaded state: Bursts and Duplicates section headings + KPI labels render
 *   - Loaded state: "No groups have been resolved yet" when a section's
 *     outcome total (kept+archived+deleted) is 0, even though identified > 0
 *
 * Note: CompositionDonut imports @mui/x-charts/PieChart. Mocked below so the
 * page render test doesn't depend on canvas/SVG chart internals (same
 * convention as StorageInsightsPage.test.tsx).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted before component imports)
// ---------------------------------------------------------------------------

vi.mock('@mui/x-charts/PieChart', () => ({
  PieChart: () => null,
}));

vi.mock('../../components/insights/CompositionDonut', () => ({
  CompositionDonut: ({ title }: { title: string }) => (
    <div data-testid={`donut-${title.replace(/\s+/g, '-').toLowerCase()}`}>{title}</div>
  ),
}));

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../hooks/useReviewInsights', () => ({
  useReviewInsights: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import ReviewInsightsPage from '../../pages/Insights/ReviewInsightsPage';
import { useCircle } from '../../hooks/useCircle';
import { useReviewInsights } from '../../hooks/useReviewInsights';
import type { ReviewInsights } from '../../services/reviewInsights';

const mockUseCircle = vi.mocked(useCircle);
const mockUseReviewInsights = vi.mocked(useReviewInsights);

// ---------------------------------------------------------------------------
// Fixtures
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

function makeCircleContext(
  overrides: Partial<ReturnType<typeof useCircle>> = {},
): ReturnType<typeof useCircle> {
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

const emptyMetrics = {
  identified: 0,
  pending: 0,
  resolved: 0,
  dismissed: 0,
  archivedGroups: 0,
  trashedGroups: 0,
  itemsKept: 0,
  itemsArchived: 0,
  itemsDeleted: 0,
};

const emptyInsights: ReviewInsights = {
  bursts: { ...emptyMetrics },
  duplicates: { ...emptyMetrics },
};

const loadedInsights: ReviewInsights = {
  bursts: {
    identified: 12,
    pending: 4,
    resolved: 6,
    dismissed: 2,
    archivedGroups: 5,
    trashedGroups: 1,
    itemsKept: 6,
    itemsArchived: 20,
    itemsDeleted: 3,
  },
  duplicates: {
    // identified > 0 but nothing resolved yet — outcome donut should show the
    // "no groups resolved yet" message instead of a chart.
    identified: 9,
    pending: 9,
    resolved: 0,
    dismissed: 0,
    archivedGroups: 0,
    trashedGroups: 0,
    itemsKept: 0,
    itemsArchived: 0,
    itemsDeleted: 0,
  },
};

function makeHookReturn(
  overrides: Partial<ReturnType<typeof useReviewInsights>> = {},
): ReturnType<typeof useReviewInsights> {
  return {
    data: loadedInsights,
    loading: false,
    error: null,
    reload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewInsightsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCircle.mockReturnValue(makeCircleContext());
    mockUseReviewInsights.mockReturnValue(makeHookReturn());
  });

  describe('no active circle', () => {
    it('shows a select-a-circle alert and does not render KPI content', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircle: null, activeCircleId: null }));

      render(<ReviewInsightsPage />);

      expect(screen.getByText(/select a circle to view review insights/i)).toBeInTheDocument();
      expect(screen.queryByText('Review Insights')).toBeNull();
    });
  });

  describe('loading state', () => {
    it('renders skeleton placeholders while loading', () => {
      mockUseReviewInsights.mockReturnValue(makeHookReturn({ loading: true, data: null }));

      render(<ReviewInsightsPage />);

      // KpiSkeleton renders MUI Skeleton components without a distinguishing
      // test id; assert via the absence of loaded KPI content instead.
      expect(screen.queryByText('Identified')).toBeNull();
      expect(screen.queryByText(/no review activity yet/i)).toBeNull();
    });
  });

  describe('error state', () => {
    it('renders the error message in an Alert', () => {
      mockUseReviewInsights.mockReturnValue(
        makeHookReturn({ error: 'Failed to fetch insights', data: null }),
      );

      render(<ReviewInsightsPage />);

      expect(screen.getByText('Failed to fetch insights')).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows "No review activity yet" when both bursts and duplicates have zero identified groups', () => {
      mockUseReviewInsights.mockReturnValue(makeHookReturn({ data: emptyInsights }));

      render(<ReviewInsightsPage />);

      expect(screen.getByText(/no review activity yet/i)).toBeInTheDocument();
    });

    it('does not show the empty state while data is still loading', () => {
      mockUseReviewInsights.mockReturnValue(makeHookReturn({ data: null, loading: true }));

      render(<ReviewInsightsPage />);

      expect(screen.queryByText(/no review activity yet/i)).toBeNull();
    });
  });

  describe('loaded state', () => {
    it('renders the "Review Insights" heading', () => {
      render(<ReviewInsightsPage />);

      expect(screen.getByText('Review Insights')).toBeInTheDocument();
    });

    it('renders both the Bursts and Duplicates section headings', () => {
      render(<ReviewInsightsPage />);

      expect(screen.getByText('Bursts')).toBeInTheDocument();
      expect(screen.getByText('Duplicates')).toBeInTheDocument();
    });

    it('renders the Identified/Pending/Resolved/Dismissed KPI labels', () => {
      render(<ReviewInsightsPage />);

      expect(screen.getAllByText('Identified').length).toBe(2); // one per section
      expect(screen.getAllByText('Pending').length).toBe(2);
      expect(screen.getAllByText('Resolved').length).toBe(2);
      expect(screen.getAllByText('Dismissed').length).toBe(2);
    });

    it('shows "No groups have been resolved yet" for the duplicates section when its outcome total is 0', async () => {
      render(<ReviewInsightsPage />);

      await waitFor(() => {
        expect(screen.getByText(/no groups have been resolved yet/i)).toBeInTheDocument();
      });
    });

    it('renders the bursts outcome donut when the bursts section has resolved activity', async () => {
      render(<ReviewInsightsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('donut-kept-vs-removed')).toBeInTheDocument();
      });
    });
  });
});

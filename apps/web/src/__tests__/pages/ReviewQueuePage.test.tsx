/**
 * Tests for ReviewQueuePage (issue #390, spec §4.5).
 *
 * A WRAPPER, not a rewrite: each queue's existing standalone page is mounted
 * verbatim inside `/review/:queue`. The six wrapped page modules are mocked
 * to lightweight stubs so these tests exercise the wrapper's own logic
 * (resolution, redirect, chain-to-next, back affordance) rather than each
 * page's internals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { render } from '../utils/test-utils';
import ReviewQueuePage from '../../pages/Reviews/ReviewQueuePage';
import { REVIEW_QUEUES, type ReviewQueueKey } from '../../config/reviewQueues';
import type { ResolvedReviewQueue } from '../../hooks/useReviewQueues';

vi.mock('../../hooks/useReviewQueues', () => ({
  useReviewQueues: vi.fn(),
}));

vi.mock('../../pages/Bursts/BurstsPage', () => ({
  default: () => <div>BurstsPageStub</div>,
}));
vi.mock('../../pages/Duplicates/DuplicatesPage', () => ({
  default: () => <div>DuplicatesPageStub</div>,
}));
vi.mock('../../pages/LocationSuggestions/LocationSuggestionsPage', () => ({
  default: () => <div>LocationSuggestionsPageStub</div>,
}));
vi.mock('../../pages/Enhancements/EnhancementsPage', () => ({
  default: () => <div>EnhancementsPageStub</div>,
}));
vi.mock('../../pages/Insights/ReviewInsightsPage', () => ({
  default: () => <div>ReviewInsightsPageStub</div>,
}));
vi.mock('../../pages/Workflows/WorkflowListPage', () => ({
  default: () => <div>WorkflowListPageStub</div>,
}));

import { useReviewQueues } from '../../hooks/useReviewQueues';

const mockUseReviewQueues = vi.mocked(useReviewQueues);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEntries(
  counts: Partial<Record<ReviewQueueKey, number | null>>,
  enabledKeys: ReviewQueueKey[],
): ResolvedReviewQueue[] {
  return REVIEW_QUEUES.filter((def) => enabledKeys.includes(def.key)).map((def) => ({
    ...def,
    count: def.countKey ? (counts[def.key] ?? null) : null,
  }));
}

function mockResult(overrides: Partial<ReturnType<typeof useReviewQueues>>) {
  mockUseReviewQueues.mockReturnValue({
    entries: [],
    counts: null,
    totalPending: 0,
    isLoading: false,
    anyEnabled: true,
    ...overrides,
  });
}

function renderAt(path: string) {
  return render(
    <Routes>
      <Route path="/review/:queue" element={<ReviewQueuePage />} />
      <Route path="/review" element={<div>ReviewHubStub</div>} />
    </Routes>,
    { wrapperOptions: { route: path } },
  );
}

describe('ReviewQueuePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Wraps the correct page
  // =========================================================================

  it('/review/duplicates renders the Duplicates page', async () => {
    const entries = buildEntries({ duplicates: 4 }, ['duplicates']);
    mockResult({ entries });

    renderAt('/review/duplicates');

    expect(await screen.findByText('DuplicatesPageStub')).toBeInTheDocument();
  });

  it('/review/bursts renders the Bursts page', async () => {
    const entries = buildEntries({ bursts: 4 }, ['bursts']);
    mockResult({ entries });

    renderAt('/review/bursts');

    expect(await screen.findByText('BurstsPageStub')).toBeInTheDocument();
  });

  it('/review/insights renders the Insights page (a secondary entry, no count)', async () => {
    const entries = buildEntries({}, ['insights']);
    mockResult({ entries });

    renderAt('/review/insights');

    expect(await screen.findByText('ReviewInsightsPageStub')).toBeInTheDocument();
  });

  it('/review/automations renders the Automations (workflows) page', async () => {
    const entries = buildEntries({}, ['automations']);
    mockResult({ entries });

    renderAt('/review/automations');

    expect(await screen.findByText('WorkflowListPageStub')).toBeInTheDocument();
  });

  // =========================================================================
  // Redirects
  // =========================================================================

  describe('redirects to /review', () => {
    it('an unknown :queue segment redirects', async () => {
      mockResult({ entries: buildEntries({ bursts: 4 }, ['bursts']) });

      renderAt('/review/not-a-real-queue');

      expect(await screen.findByText('ReviewHubStub')).toBeInTheDocument();
    });

    it('a queue whose feature is off (not in the resolved entries) redirects', async () => {
      // `duplicates` is a real registry key, but not present in the resolved
      // (enabled) entries — the feature is off.
      mockResult({ entries: buildEntries({ bursts: 4 }, ['bursts']), isLoading: false });

      renderAt('/review/duplicates');

      expect(await screen.findByText('ReviewHubStub')).toBeInTheDocument();
    });

    it('does NOT redirect a disabled-looking queue while flags are still resolving — shows a spinner instead', () => {
      mockResult({ entries: [], isLoading: true });

      renderAt('/review/duplicates');

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByText('ReviewHubStub')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Chain-to-next
  // =========================================================================

  describe('chain-to-next', () => {
    it('shows "Next: N …" on a drained queue when another queue still has work, in registry order', async () => {
      // bursts (current) drained; duplicates (next in registry order) has 5.
      const entries = buildEntries({ bursts: 0, duplicates: 5 }, ['bursts', 'duplicates']);
      mockResult({ entries });

      renderAt('/review/bursts');

      await screen.findByText('BurstsPageStub');
      const next = screen.getByRole('link', { name: /Next:/ });
      expect(next).toHaveTextContent('Next: 5 duplicates');
      expect(next.getAttribute('href')).toBe('/review/duplicates');
    });

    it('wraps around to the front of the registry when the only remaining work is earlier in the order', async () => {
      // Current = enhancements (last queue-group entry); only bursts (first
      // in registry order) still has work — this can only be found by
      // wrapping around past the end of the list.
      const entries = buildEntries(
        { bursts: 3, duplicates: 0, locations: 0, enhancements: 0 },
        ['bursts', 'duplicates', 'locations', 'enhancements'],
      );
      mockResult({ entries });

      renderAt('/review/enhancements');

      await screen.findByText('EnhancementsPageStub');
      const next = screen.getByRole('link', { name: /Next:/ });
      expect(next).toHaveTextContent('Next: 3 bursts');
      expect(next.getAttribute('href')).toBe('/review/bursts');
    });

    it('is suppressed when no other queue has remaining work', async () => {
      const entries = buildEntries({ bursts: 0, duplicates: 0 }, ['bursts', 'duplicates']);
      mockResult({ entries });

      renderAt('/review/bursts');

      await screen.findByText('BurstsPageStub');
      expect(screen.queryByRole('link', { name: /Next:/ })).not.toBeInTheDocument();
    });

    it('never appears on a secondary entry, even when a real queue has pending work', async () => {
      const entries = buildEntries({ bursts: 4 }, ['bursts', 'insights']);
      mockResult({ entries });

      renderAt('/review/insights');

      await screen.findByText('ReviewInsightsPageStub');
      expect(screen.queryByRole('link', { name: /Next:/ })).not.toBeInTheDocument();
    });

    it('is not shown while the current queue still has pending items', async () => {
      const entries = buildEntries({ bursts: 4, duplicates: 5 }, ['bursts', 'duplicates']);
      mockResult({ entries });

      renderAt('/review/bursts');

      await screen.findByText('BurstsPageStub');
      expect(screen.queryByRole('link', { name: /Next:/ })).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Back affordance
  // =========================================================================

  it('a back affordance returns to /review', async () => {
    const entries = buildEntries({ bursts: 4 }, ['bursts']);
    mockResult({ entries });

    renderAt('/review/bursts');

    await screen.findByText('BurstsPageStub');
    const back = screen.getByRole('link', { name: 'Back to Review' });
    expect(back.getAttribute('href')).toBe('/review');
  });
});

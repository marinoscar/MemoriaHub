/**
 * Tests for ReviewQueueList (issue #390, spec §4.5).
 *
 * The one Review-inbox list rendered at the hub (and, from #392, the desktop
 * context pane). `useReviewQueues` is mocked directly so each case can drive
 * the resolved entry list without touching feature flags or the network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { ReviewQueueList, reviewQueuePath } from '../../../components/review/ReviewQueueList';
import { REVIEW_QUEUES, type ReviewQueueKey } from '../../../config/reviewQueues';
import type { ResolvedReviewQueue } from '../../../hooks/useReviewQueues';

vi.mock('../../../hooks/useReviewQueues', () => ({
  useReviewQueues: vi.fn(),
}));

import { useReviewQueues } from '../../../hooks/useReviewQueues';

const mockUseReviewQueues = vi.mocked(useReviewQueues);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build resolved entries from the real registry so labels/icons/paths stay
 * in sync with the shipped config rather than being hand-duplicated here. */
function buildEntries(
  counts: Partial<Record<ReviewQueueKey, number | null>>,
  enabledKeys: ReviewQueueKey[],
): ResolvedReviewQueue[] {
  return REVIEW_QUEUES.filter((def) => enabledKeys.includes(def.key)).map((def) => ({
    ...def,
    count: def.countKey ? (counts[def.key] ?? null) : null,
  }));
}

const ALL_QUEUE_KEYS: ReviewQueueKey[] = ['bursts', 'duplicates', 'locations', 'enhancements'];
const ALL_KEYS: ReviewQueueKey[] = [...ALL_QUEUE_KEYS, 'insights', 'automations'];
/** Fixed registry order, per spec §4.5 requirement 2. */
const REGISTRY_ORDER = REVIEW_QUEUES.map((d) => d.key);

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

describe('ReviewQueueList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Fixed registry order — never sorted by count
  // =========================================================================

  it('renders enabled entries in fixed registry order, unaffected by count changes', () => {
    const entries1 = buildEntries(
      { bursts: 4, duplicates: 6, locations: 2, enhancements: 0 },
      ALL_KEYS,
    );
    mockResult({ entries: entries1, anyEnabled: true });

    const { rerender } = render(<ReviewQueueList variant="hub" />);

    const namesBefore = screen.getAllByRole('link').map((el) => el.getAttribute('aria-label'));
    const keysBefore = REGISTRY_ORDER.filter((key) => ALL_KEYS.includes(key));
    expect(namesBefore).toHaveLength(keysBefore.length);

    // Wildly different counts, same set of enabled entries.
    const entries2 = buildEntries(
      { bursts: 0, duplicates: 1, locations: 99, enhancements: 3 },
      ALL_KEYS,
    );
    mockResult({ entries: entries2, anyEnabled: true });
    rerender(<ReviewQueueList variant="hub" />);

    const namesAfter = screen.getAllByRole('link').map((el) => el.getAttribute('aria-label'));

    // Extract the row KEY order from the aria-labels via their known labels,
    // rather than the (count-dependent) full strings.
    const labelToKey = new Map(REVIEW_QUEUES.map((d) => [d.label, d.key]));
    const keyOrder = (labels: (string | null)[]) =>
      labels.map((label) => {
        const bareLabel = (label ?? '').split(',')[0];
        return labelToKey.get(bareLabel);
      });

    expect(keyOrder(namesAfter)).toEqual(keyOrder(namesBefore));
    expect(keyOrder(namesBefore)).toEqual(keysBefore);
  });

  // =========================================================================
  // Drained queue reads as an em dash, never "0"
  // =========================================================================

  it('renders a drained queue as an em dash, not "0"', () => {
    const entries = buildEntries({ bursts: 0, duplicates: 5 }, ['bursts', 'duplicates']);
    mockResult({ entries, anyEnabled: true });

    render(<ReviewQueueList variant="hub" />);

    const burstsLink = screen.getByRole('link', { name: 'Bursts, none pending' });
    expect(within(burstsLink).getByText('—')).toBeInTheDocument();
    expect(within(burstsLink).queryByText('0')).not.toBeInTheDocument();
  });

  // =========================================================================
  // Accessible names carry the count
  // =========================================================================

  describe('accessible names', () => {
    it('carries the count for a pending queue: "Bursts, 4 pending"', () => {
      const entries = buildEntries({ bursts: 4 }, ['bursts']);
      mockResult({ entries, anyEnabled: true });

      render(<ReviewQueueList variant="hub" />);

      expect(screen.getByRole('link', { name: 'Bursts, 4 pending' })).toBeInTheDocument();
    });

    it('reads "none pending" at zero', () => {
      // A second, non-zero queue keeps this out of the all-clear state so the
      // zero-count row itself is asserted, not the all-clear takeover.
      const entries = buildEntries({ bursts: 0, duplicates: 5 }, ['bursts', 'duplicates']);
      mockResult({ entries, anyEnabled: true });

      render(<ReviewQueueList variant="hub" />);

      expect(screen.getByRole('link', { name: 'Bursts, none pending' })).toBeInTheDocument();
    });

    it('secondary entries carry just their label, with no count phrasing', () => {
      const entries = buildEntries({}, ['insights', 'automations']);
      mockResult({ entries, anyEnabled: true });

      render(<ReviewQueueList variant="hub" />);

      expect(screen.getByRole('link', { name: 'Insights' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Automations' })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Rows are real, focusable links
  // =========================================================================

  it('rows are real anchors with the correct href, and are keyboard-focusable', () => {
    const entries = buildEntries({ bursts: 4 }, ['bursts']);
    mockResult({ entries, anyEnabled: true });

    render(<ReviewQueueList variant="hub" />);

    const link = screen.getByRole('link', { name: 'Bursts, 4 pending' });
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(reviewQueuePath('bursts'));
    expect(reviewQueuePath('bursts')).toBe('/review/bursts');

    link.focus();
    expect(link).toHaveFocus();
  });

  // =========================================================================
  // All-clear state
  // =========================================================================

  describe('all-clear state', () => {
    it('shows ONE all-clear state when every queue is drained, not four rows of 0', () => {
      const entries = buildEntries(
        { bursts: 0, duplicates: 0, locations: 0, enhancements: 0 },
        ALL_KEYS,
      );
      mockResult({ entries, anyEnabled: true });

      render(<ReviewQueueList variant="hub" />);

      expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
      ALL_QUEUE_KEYS.forEach((key) => {
        const def = REVIEW_QUEUES.find((d) => d.key === key)!;
        expect(screen.queryByRole('link', { name: new RegExp(`^${def.label}`) })).not.toBeInTheDocument();
      });
    });

    it('still renders Insights and Automations below the all-clear state', () => {
      const entries = buildEntries(
        { bursts: 0, duplicates: 0, locations: 0, enhancements: 0 },
        ALL_KEYS,
      );
      mockResult({ entries, anyEnabled: true });

      render(<ReviewQueueList variant="hub" />);

      expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Insights' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Automations' })).toBeInTheDocument();
    });

    it('does NOT show the all-clear state when a queue count has not loaded yet (null)', () => {
      // bursts is drained, but duplicates has not resolved a count yet — this
      // must not be mistaken for "drained too".
      const entries = buildEntries({ bursts: 0, duplicates: null }, ['bursts', 'duplicates']);
      mockResult({ entries, anyEnabled: true });

      render(<ReviewQueueList variant="hub" />);

      expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
      // The unloaded row renders (as an em dash) but its accessible name
      // carries no "none pending" claim — that would state the opposite of
      // the truth while the request is still in flight.
      const duplicatesLink = screen.getByRole('link', { name: 'Duplicates' });
      expect(within(duplicatesLink).getByText('—')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Loading / all-disabled / no-queues states
  // =========================================================================

  it('shows a spinner while loading, and no rows', () => {
    mockResult({ entries: [], isLoading: true, anyEnabled: true });

    render(<ReviewQueueList variant="hub" />);

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows the all-disabled empty state when no review feature is enabled at all', () => {
    mockResult({ entries: [], isLoading: false, anyEnabled: false });

    render(<ReviewQueueList variant="hub" />);

    expect(screen.getByText(/no review features are enabled/i)).toBeInTheDocument();
  });

  it('shows a "no queues enabled" message when only secondary entries resolve', () => {
    const entries = buildEntries({}, ['insights', 'automations']);
    mockResult({ entries, anyEnabled: true });

    render(<ReviewQueueList variant="hub" />);

    expect(screen.getByText(/no review queues are enabled/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Insights' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Automations' })).toBeInTheDocument();
  });
});

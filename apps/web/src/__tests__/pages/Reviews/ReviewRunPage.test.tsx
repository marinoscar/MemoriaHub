/**
 * RTL tests for ReviewRunPage — the shared run page for all three review
 * queues (issue #190).
 *
 * This file inherits the coverage that used to live in
 * `LocationSuggestionRunPage.test.tsx`; that page was deleted once this one
 * rendered the `location_suggestion` subject identically, so the assertions
 * worth keeping moved here rather than being dropped.
 *
 * Covers:
 *   - Per-subject presentation: title, back-link, count-tile labels and the
 *     failed-item deep link are all derived from `subjectType` + `action`.
 *   - Evaluating state: indeterminate "Preparing…" bar (no `aria-valuenow`).
 *   - Running state: DETERMINATE bar (`aria-valuenow="42"` at 42/100) plus the
 *     "X of Y … processed" text, and the locale-formatted matchedCount hero.
 *   - `matchedCount === 0` while running falls back to an indeterminate bar.
 *   - A terminal run with `processedCount < matchedCount` is SUCCESS, not a
 *     stall — subjects can cascade away mid-run and shrink the work set.
 *   - Terminal alerts, scoped with `within(alert)`.
 *   - Cancel: collaborator OR circle_admin (not trash-empty's admin-only
 *     gate), hidden once terminal.
 *   - Polling: `fetchRun` re-invoked every 2s (fake timers) while non-terminal,
 *     stopping at a terminal status.
 *
 * All data hooks are mocked directly, so these tests exercise the page's own
 * render/effect logic (and the shared RunProgressPanel it renders) without a
 * real network.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';
import { api } from '../../../services/api';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../../hooks/useReviewRun', () => ({
  useReviewRun: vi.fn(),
}));

vi.mock('../../../hooks/useReviewRunItems', () => ({
  useReviewRunItems: vi.fn(),
}));

vi.mock('../../../services/reviewRuns', () => ({
  cancelReviewRun: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'cancelled' }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ runId: 'run-1' }),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import ReviewRunPage from '../../../pages/Reviews/ReviewRunPage';
import { useCircle } from '../../../hooks/useCircle';
import { useReviewRun } from '../../../hooks/useReviewRun';
import { useReviewRunItems } from '../../../hooks/useReviewRunItems';
import type { ReviewRunDetail } from '../../../types/reviewRuns';

const mockUseCircle = vi.mocked(useCircle);
const mockUseReviewRun = vi.mocked(useReviewRun);
const mockUseReviewRunItems = vi.mocked(useReviewRunItems);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCircleContext(overrides: Partial<ReturnType<typeof useCircle>> = {}) {
  return {
    activeCircle: {
      id: 'circle-1',
      name: 'Test Circle',
      description: null,
      ownerId: 'user-1',
      isPersonal: false,
      createdAt: '',
      updatedAt: '',
    },
    activeCircleId: 'circle-1',
    activeCircleRole: 'collaborator',
    circles: [],
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ReturnType<typeof useCircle>;
}

function makeRun(overrides: Partial<ReviewRunDetail> = {}): ReviewRunDetail {
  return {
    id: 'run-1',
    circleId: 'circle-1',
    subjectType: 'location_suggestion',
    action: 'accept',
    threshold: 80,
    status: 'evaluating',
    matchedCount: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedById: 'user-1',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    lastError: null,
    itemStatusCounts: {},
    ...overrides,
  };
}

type RunHookReturn = ReturnType<typeof useReviewRun>;
function makeRunHook(overrides: Partial<RunHookReturn> = {}): RunHookReturn {
  return {
    run: makeRun(),
    isLoading: false,
    error: null,
    fetchRun: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as RunHookReturn;
}

type ItemsHookReturn = ReturnType<typeof useReviewRunItems>;
function makeItemsHook(overrides: Partial<ItemsHookReturn> = {}): ItemsHookReturn {
  return {
    items: [],
    meta: null,
    isLoading: false,
    error: null,
    fetchItems: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as ItemsHookReturn;
}

beforeAll(() => {
  // The failed-items table is a DataTable (#261); jsdom performs no layout, so
  // both the container-width hook and MUI X measure 0×0 without these.
  installLayoutStubs();
});

describe('ReviewRunPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400); // desktop layout unless a test says otherwise
    mockUseCircle.mockReturnValue(makeCircleContext());
    mockUseReviewRunItems.mockReturnValue(makeItemsHook());
    // The table's layout-persistence hook reads/writes `/user-settings` (§15).
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Per-subject presentation
  // -------------------------------------------------------------------------
  describe('per-subject presentation', () => {
    it('a burst resolve run titles itself for bursts and links back to /bursts', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({
            subjectType: 'burst_group',
            action: 'resolve_archive',
            status: 'running',
            matchedCount: 10,
            processedCount: 2,
          }),
        }),
      );

      render(<ReviewRunPage />);

      expect(screen.getByRole('heading', { name: 'Resolve burst groups' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /back to bursts/i })).toBeInTheDocument();
      expect(screen.getByText('Resolving groups…')).toBeInTheDocument();
      // Success tile is labelled per queue, not generically.
      expect(screen.getByText('Resolved')).toBeInTheDocument();
      expect(screen.getByText(/2 of 10 groups processed/i)).toBeInTheDocument();
    });

    it('a duplicate dismiss run titles itself for duplicates and shows a "below threshold" chip', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({
            subjectType: 'duplicate_group',
            action: 'dismiss',
            threshold: 55,
            status: 'running',
            matchedCount: 4,
            processedCount: 1,
          }),
        }),
      );

      render(<ReviewRunPage />);

      expect(
        screen.getByRole('heading', { name: 'Dismiss duplicate groups' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /back to duplicates/i })).toBeInTheDocument();
      expect(screen.getByText('Dismissing groups…')).toBeInTheDocument();
      expect(screen.getByText('Dismissed')).toBeInTheDocument();
      // Dismiss/reject act on everything BELOW the threshold.
      expect(screen.getByText('< 55%')).toBeInTheDocument();
    });

    it('a location accept run titles itself for suggestions and shows an "at or above" chip', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({ status: 'running', matchedCount: 3, processedCount: 1 }),
        }),
      );

      render(<ReviewRunPage />);

      expect(screen.getByRole('heading', { name: 'Bulk accept locations' })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /back to location suggestions/i }),
      ).toBeInTheDocument();
      expect(screen.getByText('Applying locations…')).toBeInTheDocument();
      expect(screen.getByText('≥ 80%')).toBeInTheDocument();
    });

    it('a location reject run swaps the running title and success label', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({
            action: 'reject',
            status: 'running',
            matchedCount: 3,
            processedCount: 1,
          }),
        }),
      );

      render(<ReviewRunPage />);

      expect(screen.getByRole('heading', { name: 'Bulk reject locations' })).toBeInTheDocument();
      expect(screen.getByText('Rejecting suggestions…')).toBeInTheDocument();
      expect(screen.getByText('Rejected')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Evaluating state
  // -------------------------------------------------------------------------
  describe('evaluating state', () => {
    it('renders the indeterminate "Preparing…" progress bar', () => {
      mockUseReviewRun.mockReturnValue(makeRunHook({ run: makeRun({ status: 'evaluating' }) }));

      render(<ReviewRunPage />);

      expect(screen.getByText('Preparing…')).toBeInTheDocument();
      const progressbar = screen.getByRole('progressbar');
      // MUI's indeterminate LinearProgress has no aria-valuenow.
      expect(progressbar).not.toHaveAttribute('aria-valuenow');
    });

    it('does not show the running or terminal sections while evaluating', () => {
      mockUseReviewRun.mockReturnValue(makeRunHook({ run: makeRun({ status: 'evaluating' }) }));

      render(<ReviewRunPage />);

      expect(screen.queryByText('Applying locations…')).not.toBeInTheDocument();
      expect(screen.queryByText(/applied/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Running state
  // -------------------------------------------------------------------------
  describe('running state', () => {
    it('renders a DETERMINATE progress bar and "X of Y suggestions processed"', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({ status: 'running', matchedCount: 100, processedCount: 42 }),
        }),
      );

      render(<ReviewRunPage />);

      expect(screen.getByText(/42 of 100 suggestions processed/i)).toBeInTheDocument();

      const progressbar = screen.getByRole('progressbar');
      expect(progressbar).toHaveAttribute('aria-valuenow', '42');
    });

    it('shows the total matchedCount prominently, locale-formatted', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({ status: 'running', matchedCount: 12345, processedCount: 10 }),
        }),
      );

      render(<ReviewRunPage />);

      expect(screen.getAllByText('12,345').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('suggestions in this run')).toBeInTheDocument();
    });

    it('falls back to an indeterminate bar when matchedCount is 0 (nothing to divide by yet)', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({ status: 'running', matchedCount: 0, processedCount: 0 }),
        }),
      );

      render(<ReviewRunPage />);

      const progressbar = screen.getByRole('progressbar');
      expect(progressbar).not.toHaveAttribute('aria-valuenow');
    });

    it('clamps the bar at 100% when processedCount overshoots matchedCount', () => {
      // Concurrent batch jobs increment processedCount while matchedCount can
      // shrink (subjects cascading away), so the raw ratio can exceed 1.
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({ status: 'running', matchedCount: 10, processedCount: 25 }),
        }),
      );

      render(<ReviewRunPage />);

      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    });

    it('shows the Cancel run button for a collaborator on a non-terminal run', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({ status: 'running', matchedCount: 10, processedCount: 1 }),
        }),
      );

      render(<ReviewRunPage />);

      expect(screen.getByRole('button', { name: /cancel run/i })).toBeInTheDocument();
    });

    it('also shows the Cancel run button for circle_admin (collaborator OR circle_admin)', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleRole: 'circle_admin' }));
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({ status: 'running', matchedCount: 10, processedCount: 1 }),
        }),
      );

      render(<ReviewRunPage />);

      expect(screen.getByRole('button', { name: /cancel run/i })).toBeInTheDocument();
    });

    it('hides the Cancel run button for a plain viewer', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleRole: 'viewer' }));
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({ status: 'running', matchedCount: 10, processedCount: 1 }),
        }),
      );

      render(<ReviewRunPage />);

      expect(screen.queryByRole('button', { name: /cancel run/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Terminal states
  // -------------------------------------------------------------------------
  describe('terminal states', () => {
    it('completed (accept): shows a success Alert with the applied count', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({
            status: 'completed',
            matchedCount: 50,
            processedCount: 50,
            succeededCount: 50,
          }),
        }),
      );

      render(<ReviewRunPage />);

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText('Completed')).toBeInTheDocument();
      expect(within(alert).getByText(/applied 50 suggestions\./i)).toBeInTheDocument();
    });

    it('completed (burst dismiss): the success wording follows the subject and action', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({
            subjectType: 'burst_group',
            action: 'dismiss',
            status: 'completed',
            matchedCount: 7,
            processedCount: 7,
            succeededCount: 7,
          }),
        }),
      );

      render(<ReviewRunPage />);

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText(/dismissed 7 groups\./i)).toBeInTheDocument();
    });

    it('treats a completed run with processedCount < matchedCount as success, not a stall', () => {
      // Subjects cascade-deleted mid-run shrink the work set; finalize keys off
      // "no rows left in matched/processing", never processed === matched.
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({
            status: 'completed',
            matchedCount: 100,
            processedCount: 87,
            succeededCount: 87,
          }),
        }),
      );

      render(<ReviewRunPage />);

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText('Completed')).toBeInTheDocument();
      expect(within(alert).getByText(/applied 87 suggestions\./i)).toBeInTheDocument();
      // The gap is not reported as a failure anywhere.
      expect(screen.queryByText(/could not be processed/i)).not.toBeInTheDocument();
    });

    it('completed_with_errors: shows a warning Alert and the failed-items table', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({
            status: 'completed_with_errors',
            matchedCount: 10,
            processedCount: 10,
            succeededCount: 8,
            failedCount: 2,
          }),
        }),
      );
      mockUseReviewRunItems.mockReturnValue(
        makeItemsHook({
          items: [
            {
              id: 'ri-1',
              subjectType: 'location_suggestion',
              subjectId: 'sug-1',
              status: 'failed',
              error: 'Geocode failed',
              updatedAt: '2025-01-01T00:00:00.000Z',
              media: {
                type: 'photo',
                capturedAt: null,
                filename: 'broken.jpg',
                width: 100,
                height: 100,
              },
              thumbnailUrl: null,
            },
          ],
        }),
      );

      render(<ReviewRunPage />);

      expect(
        screen.getByText(/the run finished, but some suggestions could not be processed/i),
      ).toBeInTheDocument();
      expect(screen.getByText('Failed suggestions (2)')).toBeInTheDocument();
      expect(screen.getByText('broken.jpg')).toBeInTheDocument();
      expect(screen.getByText('Geocode failed')).toBeInTheDocument();
    });

    it('links a failed burst item back to its own group page', async () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({
            subjectType: 'burst_group',
            action: 'resolve_trash',
            status: 'completed_with_errors',
            matchedCount: 2,
            processedCount: 2,
            succeededCount: 1,
            failedCount: 1,
          }),
        }),
      );
      mockUseReviewRunItems.mockReturnValue(
        makeItemsHook({
          items: [
            {
              id: 'ri-1',
              subjectType: 'burst_group',
              subjectId: 'bg-42',
              status: 'failed',
              error: 'Resolve failed',
              updatedAt: '2025-01-01T00:00:00.000Z',
              media: null,
              thumbnailUrl: null,
            },
          ],
        }),
      );

      render(<ReviewRunPage />);

      // With no media row, the subject id is the label (truncated).
      expect(await screen.findByText('bg-42')).toBeInTheDocument();
      // One row action, so it is a bare icon button named after its row (§17.6).
      await userEvent.setup().click(screen.getByRole('button', { name: 'View for bg-42' }));
      expect(mockNavigate).toHaveBeenCalledWith('/bursts/bg-42');
    });

    it('failed: shows an error Alert with the run’s lastError', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({ run: makeRun({ status: 'failed', lastError: 'Evaluation crashed' }) }),
      );

      render(<ReviewRunPage />);

      expect(screen.getByText('Evaluation crashed')).toBeInTheDocument();
    });

    it('cancelled: shows an info Alert noting processed subjects stay processed', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({ status: 'cancelled', matchedCount: 10, processedCount: 3 }),
        }),
      );

      render(<ReviewRunPage />);

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText('Cancelled')).toBeInTheDocument();
      expect(
        within(alert).getByText(/suggestions already processed stay processed/i),
      ).toBeInTheDocument();
    });

    it('hides the Cancel run button once the run is terminal', () => {
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({
            status: 'completed',
            matchedCount: 5,
            processedCount: 5,
            succeededCount: 5,
          }),
        }),
      );

      render(<ReviewRunPage />);

      expect(screen.queryByRole('button', { name: /cancel run/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Progress polling
  // -------------------------------------------------------------------------
  describe('progress polling', () => {
    it('re-fetches the run every 2s while non-terminal, and stops once terminal', () => {
      vi.useFakeTimers();
      const fetchRun = vi.fn().mockResolvedValue(undefined);
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({ status: 'running', matchedCount: 100, processedCount: 10 }),
          fetchRun,
        }),
      );

      const { rerender } = render(<ReviewRunPage />);

      // Initial mount fetch.
      expect(fetchRun).toHaveBeenCalledTimes(1);
      expect(fetchRun).toHaveBeenCalledWith('run-1');

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(fetchRun).toHaveBeenCalledTimes(2);

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(fetchRun).toHaveBeenCalledTimes(3);

      // The run reaches a terminal status — polling must stop.
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({
            status: 'completed',
            matchedCount: 100,
            processedCount: 100,
            succeededCount: 100,
          }),
          fetchRun,
        }),
      );
      rerender(<ReviewRunPage />);

      const callsAtTerminal = fetchRun.mock.calls.length;
      act(() => {
        vi.advanceTimersByTime(10000);
      });
      expect(fetchRun).toHaveBeenCalledTimes(callsAtTerminal);
    });

    it('does not poll at all when the run starts already terminal', () => {
      vi.useFakeTimers();
      const fetchRun = vi.fn().mockResolvedValue(undefined);
      mockUseReviewRun.mockReturnValue(
        makeRunHook({
          run: makeRun({
            status: 'completed',
            matchedCount: 10,
            processedCount: 10,
            succeededCount: 10,
          }),
          fetchRun,
        }),
      );

      render(<ReviewRunPage />);
      const callsAfterMount = fetchRun.mock.calls.length;

      act(() => {
        vi.advanceTimersByTime(10000);
      });
      expect(fetchRun).toHaveBeenCalledTimes(callsAfterMount);
    });
  });

  // -------------------------------------------------------------------------
  // Live updates must not disturb the user (issue #261)
  // -------------------------------------------------------------------------
  //
  // Every run page polls its detail endpoint, so `run` — and, on a refetch,
  // `items` — are BRAND NEW OBJECTS on every tick. The failure mode this guards
  // is the one docs/specs/datatable.md §18.4 names: gating the table on
  // `loading` (`{!loading && <TableContainer>…}`, which is exactly what these
  // three pages did before #261) remounts the renderer on every tick and takes
  // card/row expansion state and the page's scroll offset with it.
  describe('live updates do not disturb the failed-items table', () => {
    function terminalRunWithFailures() {
      return makeRun({
        subjectType: 'burst_group',
        action: 'resolve_archive',
        status: 'completed_with_errors',
        matchedCount: 10,
        processedCount: 10,
        succeededCount: 8,
        failedCount: 2,
      });
    }

    /** Fresh objects with the SAME ids — what one poll tick actually produces. */
    function failedItems() {
      return [
        {
          id: 'ri-1',
          subjectType: 'burst_group' as const,
          subjectId: 'bg-11111',
          status: 'failed' as const,
          error: 'Resolve failed',
          updatedAt: new Date().toISOString(),
          media: {
            type: 'photo',
            capturedAt: null,
            filename: 'broken-one.jpg',
            width: 10,
            height: 10,
          },
          thumbnailUrl: null,
        },
        {
          id: 'ri-2',
          subjectType: 'burst_group' as const,
          subjectId: 'bg-22222',
          status: 'failed' as const,
          error: 'Resolve failed',
          updatedAt: new Date().toISOString(),
          media: {
            type: 'photo',
            capturedAt: null,
            filename: 'broken-two.jpg',
            width: 10,
            height: 10,
          },
          thumbnailUrl: null,
        },
      ];
    }

    it('preserves an expanded card and the table itself across a poll tick', async () => {
      const user = userEvent.setup();
      // A phone-width CONTAINER, so the card layout (and therefore its
      // "More details" region) is what is on screen.
      setInitialContainerWidth(400);
      mockUseReviewRun.mockReturnValue(makeRunHook({ run: terminalRunWithFailures() }));
      mockUseReviewRunItems.mockReturnValue(makeItemsHook({ items: failedItems() }));

      const { rerender } = render(<ReviewRunPage />);

      const table = await screen.findByTestId('datatable');
      await user.click(
        await screen.findByRole('button', { name: 'More details for broken-one.jpg' }),
      );
      expect(screen.getByTestId('datatable-card-detail-region')).toBeInTheDocument();

      // One poll tick: a new run object and new item objects, same ids.
      mockUseReviewRun.mockReturnValue(makeRunHook({ run: terminalRunWithFailures() }));
      mockUseReviewRunItems.mockReturnValue(makeItemsHook({ items: failedItems() }));
      rerender(<ReviewRunPage />);

      // The renderer was never unmounted…
      expect(screen.getByTestId('datatable')).toBe(table);
      // …so the expansion the user opened is still open…
      expect(screen.getByTestId('datatable-card-detail-region')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Hide details for broken-one.jpg' }),
      ).toBeInTheDocument();
      // …and both rows are still on screen.
      expect(screen.getByText('broken-one.jpg')).toBeInTheDocument();
      expect(screen.getByText('broken-two.jpg')).toBeInTheDocument();
    });

    it('keeps the rows rendered while a refetch is in flight', async () => {
      mockUseReviewRun.mockReturnValue(makeRunHook({ run: terminalRunWithFailures() }));
      mockUseReviewRunItems.mockReturnValue(
        makeItemsHook({ items: failedItems(), isLoading: true }),
      );

      render(<ReviewRunPage />);

      // `loading` is a PROP — an overlay over live rows, never a replacement
      // for the table.
      expect(await screen.findByText('broken-one.jpg')).toBeInTheDocument();
      expect(screen.getByTestId('datatable-loading-overlay')).toBeInTheDocument();
    });
  });
});

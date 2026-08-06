/**
 * RTL tests for TrashEmptyRunPage (issue #165 — Empty Trash at scale).
 *
 * Covers:
 *   - Evaluating state: renders the indeterminate "Preparing…" progress bar.
 *   - Running state: renders a DETERMINATE progress bar plus the
 *     "X of Y items processed" text, and the total matchedCount is shown
 *     prominently.
 *   - Terminal states (completed / completed_with_errors / failed /
 *     cancelled): renders the matching Alert summary.
 *   - Progress polling: fetchRun is re-invoked every 2s (fake timers) while
 *     the run is non-terminal, and polling stops once it reaches a terminal
 *     status — mirroring the WorkflowRunPage.test.tsx precedent.
 *
 * All data hooks are mocked directly, so these tests exercise
 * TrashEmptyRunPage's own render/effect logic without a real network.
 *
 * As of issue #190 the polling, progress bar, count tiles and cancel button
 * come from the shared `useRunPolling` + `RunProgressPanel` pieces rather than
 * page-local copies. These assertions are deliberately unchanged: they are the
 * evidence that the shared components preserved this page's behaviour,
 * including its stricter circle_admin cancel gate.
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

vi.mock('../../../hooks/useTrashEmptyRun', () => ({
  useTrashEmptyRun: vi.fn(),
}));

vi.mock('../../../hooks/useTrashEmptyRunItems', () => ({
  useTrashEmptyRunItems: vi.fn(),
}));

vi.mock('../../../services/trashEmptyRuns', () => ({
  cancelTrashEmptyRun: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'cancelled' }),
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

import TrashEmptyRunPage from '../../../pages/Trash/TrashEmptyRunPage';
import { useCircle } from '../../../hooks/useCircle';
import { useTrashEmptyRun } from '../../../hooks/useTrashEmptyRun';
import { useTrashEmptyRunItems } from '../../../hooks/useTrashEmptyRunItems';
import type { TrashEmptyRunDetail } from '../../../types/trashEmptyRuns';

const mockUseCircle = vi.mocked(useCircle);
const mockUseTrashEmptyRun = vi.mocked(useTrashEmptyRun);
const mockUseTrashEmptyRunItems = vi.mocked(useTrashEmptyRunItems);

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
    activeCircleRole: 'circle_admin',
    circles: [],
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ReturnType<typeof useCircle>;
}

function makeRun(overrides: Partial<TrashEmptyRunDetail> = {}): TrashEmptyRunDetail {
  return {
    id: 'run-1',
    circleId: 'circle-1',
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

type RunHookReturn = ReturnType<typeof useTrashEmptyRun>;
function makeRunHook(overrides: Partial<RunHookReturn> = {}): RunHookReturn {
  return {
    run: makeRun(),
    isLoading: false,
    error: null,
    fetchRun: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as RunHookReturn;
}

type ItemsHookReturn = ReturnType<typeof useTrashEmptyRunItems>;
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

describe('TrashEmptyRunPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400); // desktop layout unless a test says otherwise
    mockUseCircle.mockReturnValue(makeCircleContext());
    mockUseTrashEmptyRunItems.mockReturnValue(makeItemsHook());
    // The table's layout-persistence hook reads/writes `/user-settings` (§15).
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Evaluating state
  // -------------------------------------------------------------------------
  describe('evaluating state', () => {
    it('renders the indeterminate "Preparing…" progress bar', () => {
      const run = makeRun({ status: 'evaluating' });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run }));

      render(<TrashEmptyRunPage />);

      expect(screen.getByText('Preparing…')).toBeInTheDocument();
      const progressbar = screen.getByRole('progressbar');
      // MUI's indeterminate LinearProgress has no aria-valuenow.
      expect(progressbar).not.toHaveAttribute('aria-valuenow');
    });

    it('does not show the running or terminal sections while evaluating', () => {
      const run = makeRun({ status: 'evaluating' });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run }));

      render(<TrashEmptyRunPage />);

      expect(screen.queryByText('Deleting items…')).not.toBeInTheDocument();
      expect(screen.queryByText(/permanently deleted/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Running state
  // -------------------------------------------------------------------------
  describe('running state', () => {
    it('renders a DETERMINATE progress bar and "X of Y items processed"', () => {
      const run = makeRun({ status: 'running', matchedCount: 100, processedCount: 42 });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run }));

      render(<TrashEmptyRunPage />);

      expect(screen.getByText('Deleting items…')).toBeInTheDocument();
      expect(screen.getByText(/42 of 100 items processed/i)).toBeInTheDocument();

      const progressbar = screen.getByRole('progressbar');
      expect(progressbar).toHaveAttribute('aria-valuenow', '42');
    });

    it('shows the total matchedCount prominently at the top of the page', () => {
      const run = makeRun({ status: 'running', matchedCount: 12345, processedCount: 10 });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run }));

      render(<TrashEmptyRunPage />);

      expect(screen.getAllByText('12,345').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('items in this run')).toBeInTheDocument();
    });

    it('falls back to an indeterminate bar when matchedCount is 0 (still evaluating rows to purge)', () => {
      const run = makeRun({ status: 'running', matchedCount: 0, processedCount: 0 });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run }));

      render(<TrashEmptyRunPage />);

      const progressbar = screen.getByRole('progressbar');
      expect(progressbar).not.toHaveAttribute('aria-valuenow');
    });

    it('shows the Cancel run button for a circle_admin on a non-terminal run', () => {
      const run = makeRun({ status: 'running', matchedCount: 10, processedCount: 1 });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run }));

      render(<TrashEmptyRunPage />);

      expect(screen.getByRole('button', { name: /cancel run/i })).toBeInTheDocument();
    });

    it('hides the Cancel run button for a non-circle_admin', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleRole: 'collaborator' }));
      const run = makeRun({ status: 'running', matchedCount: 10, processedCount: 1 });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run }));

      render(<TrashEmptyRunPage />);

      expect(screen.queryByRole('button', { name: /cancel run/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Terminal states
  // -------------------------------------------------------------------------
  describe('terminal states', () => {
    it('completed: shows a success Alert with the permanently-deleted count', () => {
      const run = makeRun({
        status: 'completed',
        matchedCount: 50,
        processedCount: 50,
        succeededCount: 50,
      });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run }));

      render(<TrashEmptyRunPage />);

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText('Completed')).toBeInTheDocument();
      expect(within(alert).getByText(/permanently deleted 50 items/i)).toBeInTheDocument();
    });

    it('completed_with_errors: shows a warning Alert and the failed-items table', () => {
      const run = makeRun({
        status: 'completed_with_errors',
        matchedCount: 10,
        processedCount: 10,
        succeededCount: 8,
        failedCount: 2,
      });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run }));
      mockUseTrashEmptyRunItems.mockReturnValue(
        makeItemsHook({
          items: [
            {
              id: 'ri-1',
              mediaItemId: 'm-1',
              status: 'failed',
              error: 'Hard-delete failed',
              updatedAt: '2025-01-01T00:00:00.000Z',
              media: { type: 'photo', capturedAt: null, filename: 'broken.jpg', width: 100, height: 100 },
              thumbnailUrl: null,
            },
          ],
        }),
      );

      render(<TrashEmptyRunPage />);

      expect(
        screen.getByText(/the run finished, but some items could not be deleted/i),
      ).toBeInTheDocument();
      expect(screen.getByText('Failed items (2)')).toBeInTheDocument();
      expect(screen.getByText('broken.jpg')).toBeInTheDocument();
      expect(screen.getByText('Hard-delete failed')).toBeInTheDocument();
    });

    it('failed: shows an error Alert with the run’s lastError', () => {
      const run = makeRun({ status: 'failed', lastError: 'Evaluation crashed' });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run }));

      render(<TrashEmptyRunPage />);

      expect(screen.getByText('Evaluation crashed')).toBeInTheDocument();
    });

    it('cancelled: shows an info Alert', () => {
      const run = makeRun({ status: 'cancelled', matchedCount: 10, processedCount: 3 });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run }));

      render(<TrashEmptyRunPage />);

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText('Cancelled')).toBeInTheDocument();
      expect(within(alert).getByText(/items already deleted remain deleted/i)).toBeInTheDocument();
    });

    it('hides the Cancel run button once the run is terminal', () => {
      const run = makeRun({ status: 'completed', matchedCount: 5, processedCount: 5, succeededCount: 5 });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run }));

      render(<TrashEmptyRunPage />);

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
      const runningRun = makeRun({ status: 'running', matchedCount: 100, processedCount: 10 });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run: runningRun, fetchRun }));

      const { rerender } = render(<TrashEmptyRunPage />);

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
      const completedRun = makeRun({
        status: 'completed',
        matchedCount: 100,
        processedCount: 100,
        succeededCount: 100,
      });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run: completedRun, fetchRun }));
      rerender(<TrashEmptyRunPage />);

      const callsAtTerminal = fetchRun.mock.calls.length;
      act(() => {
        vi.advanceTimersByTime(10000);
      });
      expect(fetchRun).toHaveBeenCalledTimes(callsAtTerminal);
    });

    it('does not poll at all when the run starts already terminal', () => {
      vi.useFakeTimers();
      const fetchRun = vi.fn().mockResolvedValue(undefined);
      const completedRun = makeRun({
        status: 'completed',
        matchedCount: 10,
        processedCount: 10,
        succeededCount: 10,
      });
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run: completedRun, fetchRun }));

      render(<TrashEmptyRunPage />);
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
  // The page polls its run endpoint, so `run` and (on a refetch) `items` are
  // brand-new objects on every tick. Gating the table on `loading` — which this
  // page did before #261 — would remount the renderer each time and take card
  // expansion state and the scroll offset with it (docs/specs/datatable.md
  // §18.4).
  describe('live updates do not disturb the failed-items table', () => {
    function terminalRunWithFailures() {
      return makeRun({
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
          mediaItemId: 'm-1',
          status: 'failed' as const,
          error: 'Hard-delete failed',
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
          mediaItemId: 'm-2',
          status: 'failed' as const,
          error: 'Hard-delete failed',
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
      setInitialContainerWidth(400); // card layout, so "More details" exists
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run: terminalRunWithFailures() }));
      mockUseTrashEmptyRunItems.mockReturnValue(makeItemsHook({ items: failedItems() }));

      const { rerender } = render(<TrashEmptyRunPage />);

      const table = await screen.findByTestId('datatable');
      await user.click(
        await screen.findByRole('button', { name: 'More details for broken-one.jpg' }),
      );
      expect(screen.getByTestId('datatable-card-detail-region')).toBeInTheDocument();

      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run: terminalRunWithFailures() }));
      mockUseTrashEmptyRunItems.mockReturnValue(makeItemsHook({ items: failedItems() }));
      rerender(<TrashEmptyRunPage />);

      expect(screen.getByTestId('datatable')).toBe(table);
      expect(screen.getByTestId('datatable-card-detail-region')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Hide details for broken-one.jpg' }),
      ).toBeInTheDocument();
      expect(screen.getByText('broken-one.jpg')).toBeInTheDocument();
      expect(screen.getByText('broken-two.jpg')).toBeInTheDocument();
    });

    it('keeps the rows rendered while a refetch is in flight', async () => {
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run: terminalRunWithFailures() }));
      mockUseTrashEmptyRunItems.mockReturnValue(
        makeItemsHook({ items: failedItems(), isLoading: true }),
      );

      render(<TrashEmptyRunPage />);

      expect(await screen.findByText('broken-one.jpg')).toBeInTheDocument();
      expect(screen.getByTestId('datatable-loading-overlay')).toBeInTheDocument();
    });

    it('links a failed item to its media, from a row-named action', async () => {
      mockUseTrashEmptyRun.mockReturnValue(makeRunHook({ run: terminalRunWithFailures() }));
      mockUseTrashEmptyRunItems.mockReturnValue(makeItemsHook({ items: failedItems() }));

      render(<TrashEmptyRunPage />);

      // One row action → a bare icon button named after its row (§17.6).
      await userEvent
        .setup()
        .click(await screen.findByRole('button', { name: 'View for broken-one.jpg' }));

      expect(mockNavigate).toHaveBeenCalledWith('/media?item=m-1');
    });
  });
});

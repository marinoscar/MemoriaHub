/**
 * RTL tests for EnhancementBatchPage — the bulk AI-enhance batch progress page
 * (epic #420, issue #423).
 *
 * Modelled directly on `TrashEmptyRunPage.test.tsx` / `ReviewRunPage.test.tsx`:
 * all data hooks are mocked directly, so these tests exercise the page's own
 * render/effect logic (and the shared `RunProgressPanel` + `useRunPolling`
 * pieces it assembles) without a real network.
 *
 * Covers:
 *  - Counters rendered via RunProgressPanel, with the two LOAD-BEARING relabels
 *    — "Ready to review" (succeeded) and "Cancelled" (skipped) — asserted
 *    explicitly, since everywhere else in the app "succeeded" means done and
 *    here it means waiting for the user.
 *  - "Cancel remaining" wording, and the body copy stating in-flight
 *    enhancements are left to finish.
 *  - Cancel visibility: gated by per-circle role (collaborator+), by the
 *    active circle matching the batch's own circle, and hidden once terminal.
 *  - Cancel calling the endpoint then refetching, and a 400 surfacing the
 *    SERVER's message rather than a generic one.
 *  - "Review N results" appearing exactly when succeededCount > 0, and its
 *    link target.
 *  - An empty batch (0 queued) rendering a sensible terminal state rather than
 *    a stuck progress bar.
 *  - Unknown id / cross-circle batch → a clean not-found, never an unhandled
 *    error.
 *  - The failed-items table when failedCount > 0.
 *  - Progress polling: `fetchBatch` re-invoked every 2s (fake timers) while
 *    non-terminal, and STOPS the instant a poll tick reports a terminal
 *    status — the assertion most likely to regress silently, per issue #423.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';
import { api } from '../../../services/api';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../../hooks/useEnhancementBatch', () => ({
  useEnhancementBatch: vi.fn(),
}));

vi.mock('../../../services/enhance', () => ({
  cancelEnhancementBatch: vi.fn(),
  listEnhancements: vi.fn().mockResolvedValue({
    items: [],
    meta: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 },
  }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ batchId: 'batch-1' }),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import EnhancementBatchPage from '../../../pages/Enhancements/EnhancementBatchPage';
import { useCircle } from '../../../hooks/useCircle';
import { useEnhancementBatch } from '../../../hooks/useEnhancementBatch';
import { cancelEnhancementBatch, listEnhancements } from '../../../services/enhance';
import type { EnhancementBatch, EnhancementListItem } from '../../../services/enhance';

const mockUseCircle = vi.mocked(useCircle);
const mockUseEnhancementBatch = vi.mocked(useEnhancementBatch);
const mockCancelEnhancementBatch = vi.mocked(cancelEnhancementBatch);
const mockListEnhancements = vi.mocked(listEnhancements);

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

function makeBatch(overrides: Partial<EnhancementBatch> = {}): EnhancementBatch {
  return {
    id: 'batch-1',
    circleId: 'circle-1',
    status: 'running',
    matchedCount: 10,
    processedCount: 5,
    succeededCount: 3,
    // Deliberately 0 by default: a nonzero failedCount triggers the page's
    // failed-items `listEnhancements` fetch, which most tests below never
    // await — opt in explicitly (see the "failed items" describe block).
    failedCount: 0,
    skippedCount: 1,
    startedById: 'user-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:10.000Z',
    startedAt: '2026-08-01T00:00:01.000Z',
    finishedAt: null,
    lastError: null,
    requestedCount: 10,
    queuedCount: 10,
    skipped: null,
    params: { preset: 'restore_old_photo', strength: 'strong' },
    source: 'selection',
    cancelledAt: null,
    ...overrides,
  };
}

type BatchHookReturn = ReturnType<typeof useEnhancementBatch>;
function makeBatchHook(overrides: Partial<BatchHookReturn> = {}): BatchHookReturn {
  return {
    batch: makeBatch(),
    isLoading: false,
    error: null,
    fetchBatch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as BatchHookReturn;
}

function makeFailedItem(overrides: Partial<EnhancementListItem> = {}): EnhancementListItem {
  return {
    id: 'enh-1',
    mediaItemId: 'm-1',
    status: 'failed',
    decision: null,
    model: 'gpt-image-1',
    params: {},
    original: { thumbnailUrl: 'https://cdn/o.jpg', width: 100, height: 100, size: '1000' },
    enhanced: { thumbnailUrl: null, width: null, height: null, size: null },
    downscaled: false,
    expiresAt: null,
    lastError: 'The model returned a 400',
    resultMediaItemId: null,
    sourceFilename: 'broken.jpg',
    capturedAt: null,
    createdBy: { id: 'user-1', name: 'Test User' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeAll(() => {
  // The failed-items table is a DataTable; jsdom performs no layout, so both
  // the container-width hook and MUI X measure 0×0 without these.
  installLayoutStubs();
});

describe('EnhancementBatchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400); // desktop layout unless a test says otherwise
    mockUseCircle.mockReturnValue(makeCircleContext());
    mockListEnhancements.mockResolvedValue({
      items: [],
      meta: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 },
    });
    // The failed-items table's layout-persistence hook reads/writes
    // `/user-settings` (docs/specs/datatable.md §15).
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Counters
  // -------------------------------------------------------------------------
  describe('counters', () => {
    it('renders the counters via RunProgressPanel, with the load-bearing succeeded/skipped relabels', async () => {
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({
          batch: makeBatch({
            matchedCount: 10,
            processedCount: 5,
            succeededCount: 3,
            failedCount: 1,
            skippedCount: 2,
          }),
        }),
      );

      render(<EnhancementBatchPage />);
      // failedCount > 0 triggers the failed-items fetch; let it settle so it
      // never resolves after this test's own assertions have returned.
      await screen.findByText('Failed photos (1)');

      // "Succeeded" is relabelled "Ready to review" — everywhere else in the
      // app that word means DONE; here it means waiting for the user.
      const readyTile = screen.getByText('Ready to review').closest('.MuiCardContent-root');
      expect(readyTile).not.toBeNull();
      expect(readyTile).toHaveTextContent('3');
      expect(screen.queryByText('Succeeded')).not.toBeInTheDocument();

      // "Skipped" is relabelled "Cancelled" — these rows were withdrawn by a
      // cancel, not skipped for some other reason.
      const cancelledTile = screen.getByText('Cancelled').closest('.MuiCardContent-root');
      expect(cancelledTile).not.toBeNull();
      expect(cancelledTile).toHaveTextContent('2');
      expect(screen.queryByText('Skipped')).not.toBeInTheDocument();

      // The generic tiles keep their default labels.
      const totalTile = screen.getByText('Total').closest('.MuiCardContent-root');
      expect(totalTile).toHaveTextContent('10');
      const processedTile = screen.getByText('Processed').closest('.MuiCardContent-root');
      expect(processedTile).toHaveTextContent('5');
      const failedTile = screen.getByText('Failed').closest('.MuiCardContent-root');
      expect(failedTile).toHaveTextContent('1');
    });
  });

  // -------------------------------------------------------------------------
  // Cancel: wording, gating, behaviour
  // -------------------------------------------------------------------------
  describe('cancel', () => {
    it('reads "Cancel remaining" and the body states in-flight photos will finish', () => {
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook());

      render(<EnhancementBatchPage />);

      expect(screen.getByRole('button', { name: 'Cancel remaining' })).toBeInTheDocument();
      expect(
        screen.getByText(/any photo already being enhanced finishes/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/its AI credits are already spent/i),
      ).toBeInTheDocument();
    });

    it('is visible for a collaborator on a matching, non-terminal batch', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleRole: 'collaborator' }));
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook());

      render(<EnhancementBatchPage />);

      expect(screen.getByRole('button', { name: 'Cancel remaining' })).toBeInTheDocument();
    });

    it('is visible for circle_admin as well (collaborator OR circle_admin)', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleRole: 'circle_admin' }));
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook());

      render(<EnhancementBatchPage />);

      expect(screen.getByRole('button', { name: 'Cancel remaining' })).toBeInTheDocument();
    });

    it('is hidden for a plain viewer', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleRole: 'viewer' }));
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook());

      render(<EnhancementBatchPage />);

      expect(screen.queryByRole('button', { name: 'Cancel remaining' })).not.toBeInTheDocument();
    });

    it('is hidden when the batch belongs to a different circle than the active one', () => {
      // A batch deep-linked from another circle carries no role we can trust,
      // so the affordance is withheld rather than guessed at.
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleRole: 'collaborator' }));
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: makeBatch({ circleId: 'circle-other' }) }),
      );

      render(<EnhancementBatchPage />);

      expect(screen.queryByRole('button', { name: 'Cancel remaining' })).not.toBeInTheDocument();
    });

    it('is hidden once the batch is terminal, even for a collaborator on a matching circle', () => {
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({
          batch: makeBatch({ status: 'completed', succeededCount: 10, processedCount: 10 }),
        }),
      );

      render(<EnhancementBatchPage />);

      expect(screen.queryByRole('button', { name: 'Cancel remaining' })).not.toBeInTheDocument();
      // The in-flight-work notice is gated the same way — nothing left to cancel.
      expect(
        screen.queryByText(/any photo already being enhanced finishes/i),
      ).not.toBeInTheDocument();
    });

    it('calls the cancel endpoint then refetches the batch', async () => {
      const user = userEvent.setup();
      const fetchBatch = vi.fn().mockResolvedValue(undefined);
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ fetchBatch }));
      mockCancelEnhancementBatch.mockResolvedValue({
        batchId: 'batch-1',
        status: 'cancelled',
        cancelled: 3,
      });

      render(<EnhancementBatchPage />);

      // Mount fetch already happened once.
      expect(fetchBatch).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole('button', { name: 'Cancel remaining' }));

      await screen.findByText('3 queued photos were cancelled');
      expect(mockCancelEnhancementBatch).toHaveBeenCalledWith('batch-1');
      expect(fetchBatch).toHaveBeenCalledTimes(2);
      expect(fetchBatch).toHaveBeenLastCalledWith('batch-1');
    });

    it('pluralizes the cancelled-count message for exactly 1', async () => {
      const user = userEvent.setup();
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook());
      mockCancelEnhancementBatch.mockResolvedValue({
        batchId: 'batch-1',
        status: 'cancelled',
        cancelled: 1,
      });

      render(<EnhancementBatchPage />);
      await user.click(screen.getByRole('button', { name: 'Cancel remaining' }));

      expect(await screen.findByText('1 queued photo was cancelled')).toBeInTheDocument();
    });

    it('a 400 (already terminal) surfaces the SERVER message, not a generic one', async () => {
      const user = userEvent.setup();
      const fetchBatch = vi.fn().mockResolvedValue(undefined);
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ fetchBatch }));
      mockCancelEnhancementBatch.mockRejectedValue(
        new Error('This batch has already finished'),
      );

      render(<EnhancementBatchPage />);
      await user.click(screen.getByRole('button', { name: 'Cancel remaining' }));

      expect(await screen.findByText('This batch has already finished')).toBeInTheDocument();
      expect(screen.queryByText('Failed to cancel the batch')).not.toBeInTheDocument();
      // Re-read after the failure too — a terminal batch is exactly the case
      // that should make the button vanish.
      expect(fetchBatch).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Review handoff
  // -------------------------------------------------------------------------
  describe('review handoff', () => {
    it('shows "No results yet" (disabled) while succeededCount is 0', () => {
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: makeBatch({ succeededCount: 0 }) }),
      );

      render(<EnhancementBatchPage />);

      const button = screen.getByRole('button', { name: 'No results yet' });
      expect(button).toBeDisabled();
      expect(screen.queryByText(/Review \d+ results?/)).not.toBeInTheDocument();
    });

    it('shows "Review N results →" and links to the batch-filtered inbox as soon as succeededCount > 0', async () => {
      const user = userEvent.setup();
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({
          batch: makeBatch({ status: 'running', succeededCount: 5, matchedCount: 20 }),
        }),
      );

      render(<EnhancementBatchPage />);

      const button = screen.getByRole('button', { name: 'Review 5 results →' });
      expect(button).toBeEnabled();

      await user.click(button);
      expect(mockNavigate).toHaveBeenCalledWith('/enhancements?batchId=batch-1');
    });

    it('singularizes "Review 1 result →"', () => {
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: makeBatch({ succeededCount: 1 }) }),
      );

      render(<EnhancementBatchPage />);

      expect(screen.getByRole('button', { name: 'Review 1 result →' })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Empty batch
  // -------------------------------------------------------------------------
  describe('empty batch', () => {
    it('renders a sensible terminal state rather than a stuck progress bar', () => {
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({
          batch: makeBatch({
            status: 'completed',
            requestedCount: 0,
            queuedCount: 0,
            matchedCount: 0,
            processedCount: 0,
            succeededCount: 0,
            failedCount: 0,
            skippedCount: 0,
          }),
        }),
      );

      render(<EnhancementBatchPage />);

      // Neither the evaluating nor the running block (the only two places a
      // LinearProgress can appear) is rendered for a terminal batch.
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      // A terminal summary alert IS shown.
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'No results yet' })).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------------
  describe('not found', () => {
    it('shows a spinner while the initial load is in flight', () => {
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: null, isLoading: true }),
      );

      render(<EnhancementBatchPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows the SERVER error for an unknown id, with a way back, not an unhandled error', async () => {
      const user = userEvent.setup();
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: null, isLoading: false, error: 'Enhancement batch not found' }),
      );

      render(<EnhancementBatchPage />);

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText('Enhancement batch not found')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /back to ai enhancements/i }));
      expect(mockNavigate).toHaveBeenCalledWith('/enhancements');
    });

    it('falls back to a generic not-found message when the hook reports no error text (e.g. cross-circle batch)', () => {
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: null, isLoading: false, error: null }),
      );

      render(<EnhancementBatchPage />);

      expect(
        within(screen.getByRole('alert')).getByText('Enhancement batch not found.'),
      ).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Failed items
  // -------------------------------------------------------------------------
  describe('failed items', () => {
    it('renders the failed-items table when failedCount > 0', async () => {
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({
          batch: makeBatch({
            status: 'completed_with_errors',
            matchedCount: 10,
            processedCount: 10,
            succeededCount: 8,
            failedCount: 2,
          }),
        }),
      );
      mockListEnhancements.mockResolvedValue({
        items: [
          makeFailedItem({ id: 'enh-1', sourceFilename: 'broken-one.jpg' }),
          makeFailedItem({ id: 'enh-2', sourceFilename: 'broken-two.jpg', mediaItemId: 'm-2' }),
        ],
        meta: { page: 1, pageSize: 25, totalItems: 2, totalPages: 1 },
      });

      render(<EnhancementBatchPage />);

      expect(screen.getByText('Failed photos (2)')).toBeInTheDocument();
      expect(await screen.findByText('broken-one.jpg')).toBeInTheDocument();
      expect(screen.getByText('broken-two.jpg')).toBeInTheDocument();

      expect(mockListEnhancements).toHaveBeenCalledWith(
        expect.objectContaining({
          circleId: 'circle-1',
          batchId: 'batch-1',
          status: 'failed',
          page: 1,
          pageSize: 25,
        }),
      );
    });

    it('does not render the failed-items table when failedCount is 0', () => {
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: makeBatch({ failedCount: 0 }) }),
      );

      render(<EnhancementBatchPage />);

      expect(screen.queryByText(/^Failed photos/)).not.toBeInTheDocument();
      expect(mockListEnhancements).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Progress polling — the assertion most likely to regress silently.
  // -------------------------------------------------------------------------
  describe('progress polling', () => {
    it('re-fetches the batch every 2s while non-terminal, and issues NO FURTHER requests once a poll tick reports a terminal status', () => {
      vi.useFakeTimers();
      const fetchBatch = vi.fn().mockResolvedValue(undefined);
      const runningBatch = makeBatch({ status: 'running', matchedCount: 100, processedCount: 10 });
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ batch: runningBatch, fetchBatch }));

      const { rerender } = render(<EnhancementBatchPage />);

      // Initial mount fetch.
      expect(fetchBatch).toHaveBeenCalledTimes(1);
      expect(fetchBatch).toHaveBeenCalledWith('batch-1');

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(fetchBatch).toHaveBeenCalledTimes(2);

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(fetchBatch).toHaveBeenCalledTimes(3);

      // A poll tick reports the batch is now complete — the transition this
      // test exists to cover.
      const completedBatch = makeBatch({
        status: 'completed',
        matchedCount: 100,
        processedCount: 100,
        succeededCount: 100,
      });
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: completedBatch, fetchBatch }),
      );
      rerender(<EnhancementBatchPage />);

      const callsAtTerminal = fetchBatch.mock.calls.length;
      act(() => {
        vi.advanceTimersByTime(10000);
      });
      // No further requests — the request count must not keep increasing.
      expect(fetchBatch).toHaveBeenCalledTimes(callsAtTerminal);
    });

    it('does not poll at all when the batch starts already terminal', () => {
      vi.useFakeTimers();
      const fetchBatch = vi.fn().mockResolvedValue(undefined);
      const completedBatch = makeBatch({
        status: 'completed',
        matchedCount: 10,
        processedCount: 10,
        succeededCount: 10,
      });
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: completedBatch, fetchBatch }),
      );

      render(<EnhancementBatchPage />);
      const callsAfterMount = fetchBatch.mock.calls.length;

      act(() => {
        vi.advanceTimersByTime(10000);
      });
      expect(fetchBatch).toHaveBeenCalledTimes(callsAfterMount);
    });
  });
});

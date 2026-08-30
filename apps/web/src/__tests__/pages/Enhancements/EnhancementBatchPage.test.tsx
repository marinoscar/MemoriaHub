/**
 * RTL tests for EnhancementBatchPage (epic #420, issue #423 — batch AI
 * enhancement progress page).
 *
 * Covers:
 *   - Counters render from a mocked batch via the shared RunProgressPanel.
 *   - "Review N results" appears once succeededCount > 0, and is absent at 0.
 *   - Cancel is gated by circle role (collaborator/circle_admin — NOT viewer,
 *     which is looser than TrashEmptyRunPage's circle_admin-only gate).
 *   - Cancel calls the endpoint, then refetches the batch.
 *   - A cancel 400 surfaces the server's own message.
 *   - An unknown/inaccessible batch id renders a clean not-found state rather
 *     than an unhandled error.
 *   - THE critical assertion: progress polling terminates the instant the
 *     batch transitions running -> completed — no further fetchBatch calls,
 *     mirroring the TrashEmptyRunPage.test.tsx precedent for useRunPolling.
 *
 * `useEnhancementBatch` is mocked directly, so these tests exercise the page's
 * own render/effect logic (and the real `useRunPolling` hook) without a real
 * network — only `cancelEnhancementBatch`/`listEnhancements` are mocked service
 * calls.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { installLayoutStubs, resetContainerWidth } from '../../../components/datatable/__tests__/testUtils/layoutStubs';

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
    useParams: () => ({ id: 'batch-1' }),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import EnhancementBatchPage from '../../../pages/Enhancements/EnhancementBatchPage';
import { useCircle } from '../../../hooks/useCircle';
import { useEnhancementBatch } from '../../../hooks/useEnhancementBatch';
import { cancelEnhancementBatch, listEnhancements } from '../../../services/enhance';
import type { EnhancementBatch } from '../../../services/enhance';

const mockUseCircle = vi.mocked(useCircle);
const mockUseEnhancementBatch = vi.mocked(useEnhancementBatch);
const mockCancel = vi.mocked(cancelEnhancementBatch);
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
    processedCount: 3,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedById: 'user-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    startedAt: '2026-08-01T00:00:00.000Z',
    finishedAt: null,
    lastError: null,
    requestedCount: 10,
    queuedCount: 10,
    skipped: null,
    params: {},
    source: 'bulk',
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

beforeAll(() => {
  // The failed-items table is a DataTable; jsdom performs no layout, so both
  // the container-width hook and MUI X measure 0x0 without these.
  installLayoutStubs();
});

describe('EnhancementBatchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    mockUseCircle.mockReturnValue(makeCircleContext());
    mockCancel.mockResolvedValue({ batchId: 'batch-1', status: 'running', cancelled: 3 });
    mockListEnhancements.mockResolvedValue({
      items: [],
      meta: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Counters
  // -------------------------------------------------------------------------
  describe('counters', () => {
    it('renders the shared run counters from the mocked batch', () => {
      const batch = makeBatch({
        matchedCount: 25,
        processedCount: 12,
        succeededCount: 8,
        failedCount: 1,
        skippedCount: 3,
      });
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ batch }));

      render(<EnhancementBatchPage />);

      expect(screen.getAllByText('25').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('12 of 25 photos processed')).toBeInTheDocument();
      // "Ready to review" replaces the generic "Succeeded" label on this page.
      expect(screen.getByText('Ready to review')).toBeInTheDocument();
      expect(screen.getByText('8')).toBeInTheDocument();
    });

    it('shows "Review N results" once succeededCount > 0', () => {
      const batch = makeBatch({ status: 'running', succeededCount: 4 });
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ batch }));

      render(<EnhancementBatchPage />);

      expect(
        screen.getByRole('link', { name: /review 4 results/i }),
      ).toHaveAttribute('href', '/enhancements?batchId=batch-1');
    });

    it('does NOT show "Review results" when succeededCount is 0', () => {
      const batch = makeBatch({ status: 'running', succeededCount: 0 });
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ batch }));

      render(<EnhancementBatchPage />);

      expect(screen.queryByRole('link', { name: /review .* results?/i })).not.toBeInTheDocument();
    });

    it('uses singular "result" copy for exactly one succeeded item', () => {
      const batch = makeBatch({ status: 'running', succeededCount: 1 });
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ batch }));

      render(<EnhancementBatchPage />);

      expect(screen.getByRole('link', { name: /^review 1 result\s/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Cancel — gated by circle role
  // -------------------------------------------------------------------------
  describe('cancel gating', () => {
    it('shows "Cancel remaining" for a collaborator on a non-terminal batch', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleRole: 'collaborator' }));
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ batch: makeBatch({ status: 'running' }) }));

      render(<EnhancementBatchPage />);

      expect(screen.getByRole('button', { name: /cancel remaining/i })).toBeInTheDocument();
    });

    it('shows the cancel button for a circle_admin too', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleRole: 'circle_admin' }));
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ batch: makeBatch({ status: 'running' }) }));

      render(<EnhancementBatchPage />);

      expect(screen.getByRole('button', { name: /cancel remaining/i })).toBeInTheDocument();
    });

    it('hides the cancel button for a viewer', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleRole: 'viewer' }));
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ batch: makeBatch({ status: 'running' }) }));

      render(<EnhancementBatchPage />);

      expect(screen.queryByRole('button', { name: /cancel remaining/i })).not.toBeInTheDocument();
    });

    it('hides the cancel button once the batch is terminal, even for a collaborator', () => {
      mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleRole: 'collaborator' }));
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: makeBatch({ status: 'completed', succeededCount: 10 }) }),
      );

      render(<EnhancementBatchPage />);

      expect(screen.queryByRole('button', { name: /cancel remaining/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Cancel action
  // -------------------------------------------------------------------------
  describe('cancel action', () => {
    it('calls the cancel endpoint and refetches the batch on success', async () => {
      const user = userEvent.setup();
      const fetchBatch = vi.fn().mockResolvedValue(undefined);
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: makeBatch({ status: 'running' }), fetchBatch }),
      );

      render(<EnhancementBatchPage />);
      fetchBatch.mockClear(); // drop the initial mount fetch

      await user.click(screen.getByRole('button', { name: /cancel remaining/i }));

      expect(mockCancel).toHaveBeenCalledWith('batch-1');
      await screen.findByText(/cancelled 3 queued photos/i);
      expect(fetchBatch).toHaveBeenCalledWith('batch-1');
    });

    it('surfaces the server\'s message verbatim on a 400 (already finished)', async () => {
      const user = userEvent.setup();
      mockCancel.mockRejectedValueOnce(new Error('This batch has already finished'));
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: makeBatch({ status: 'running' }) }),
      );

      render(<EnhancementBatchPage />);
      await user.click(screen.getByRole('button', { name: /cancel remaining/i }));

      expect(await screen.findByText('This batch has already finished')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Unknown id / not found
  // -------------------------------------------------------------------------
  describe('not found', () => {
    it('renders a clean not-found state for an unknown or inaccessible batch id', () => {
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: null, error: 'Enhancement batch not found' }),
      );

      render(<EnhancementBatchPage />);

      expect(screen.getByText('Enhancement batch not found')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /back to ai enhancements/i }),
      ).toBeInTheDocument();
      // No progress panel, no counters, no crash.
      expect(screen.queryByText(/photos processed/i)).not.toBeInTheDocument();
    });

    it('navigates back to the hub from the not-found state', async () => {
      const user = userEvent.setup();
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ batch: null, error: null }));

      render(<EnhancementBatchPage />);
      await user.click(screen.getByRole('button', { name: /back to ai enhancements/i }));

      expect(mockNavigate).toHaveBeenCalledWith('/enhancements');
    });

    it('shows a first-load spinner while there is no batch yet and a fetch is in flight', () => {
      mockUseEnhancementBatch.mockReturnValue(
        makeBatchHook({ batch: null, isLoading: true }),
      );

      render(<EnhancementBatchPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Progress polling — the critical assertion
  // -------------------------------------------------------------------------
  describe('progress polling', () => {
    it('re-fetches the batch every 2s while non-terminal, and STOPS the instant it becomes terminal — no leaked interval', () => {
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

      // The batch transitions to a terminal status BETWEEN ticks — the very
      // next render must carry no further scheduled fetch.
      const completedBatch = makeBatch({
        status: 'completed',
        matchedCount: 100,
        processedCount: 100,
        succeededCount: 100,
      });
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ batch: completedBatch, fetchBatch }));
      rerender(<EnhancementBatchPage />);

      const callsAtTerminal = fetchBatch.mock.calls.length;
      // Advance well past several would-be tick intervals — a leaked interval
      // on a hub page is a real ongoing cost, so this must be zero, not "fewer".
      act(() => {
        vi.advanceTimersByTime(20000);
      });
      expect(fetchBatch).toHaveBeenCalledTimes(callsAtTerminal);
    });

    it('does not poll at all when the batch starts already terminal', () => {
      vi.useFakeTimers();
      const fetchBatch = vi.fn().mockResolvedValue(undefined);
      const completedBatch = makeBatch({ status: 'completed', succeededCount: 10 });
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ batch: completedBatch, fetchBatch }));

      render(<EnhancementBatchPage />);
      const callsAfterMount = fetchBatch.mock.calls.length;

      act(() => {
        vi.advanceTimersByTime(10000);
      });
      expect(fetchBatch).toHaveBeenCalledTimes(callsAfterMount);
    });
  });

  // -------------------------------------------------------------------------
  // Failed items table
  // -------------------------------------------------------------------------
  describe('failed items', () => {
    it('renders the failed-items table only when failedCount > 0, listing via GET /media/enhancements?batchId=', async () => {
      mockListEnhancements.mockResolvedValueOnce({
        items: [
          {
            id: 'enh-9',
            mediaItemId: 'media-9',
            status: 'failed',
            decision: null,
            model: 'gpt-image-1',
            params: null,
            original: { thumbnailUrl: null, width: 100, height: 100, size: null },
            enhanced: { thumbnailUrl: null, width: null, height: null, size: null },
            downscaled: false,
            expiresAt: null,
            lastError: 'The model returned a 400',
            resultMediaItemId: null,
            sourceFilename: 'broken.jpg',
            capturedAt: null,
            createdBy: null,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        meta: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 },
      });
      const batch = makeBatch({ status: 'completed_with_errors', failedCount: 1, succeededCount: 8 });
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ batch }));

      render(<EnhancementBatchPage />);

      expect(await screen.findByText('broken.jpg')).toBeInTheDocument();
      expect(mockListEnhancements).toHaveBeenCalledWith(
        expect.objectContaining({ circleId: 'circle-1', batchId: 'batch-1', status: 'failed' }),
      );
      expect(screen.getByText('Failed photos (1)')).toBeInTheDocument();
    });

    it('never calls listEnhancements when there are no failed photos', () => {
      const batch = makeBatch({ status: 'completed', failedCount: 0, succeededCount: 10 });
      mockUseEnhancementBatch.mockReturnValue(makeBatchHook({ batch }));

      render(<EnhancementBatchPage />);

      expect(mockListEnhancements).not.toHaveBeenCalled();
      expect(screen.queryByText(/failed photos/i)).not.toBeInTheDocument();
    });
  });
});

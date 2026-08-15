/**
 * RecentBatches — unit tests (epic #420, issue #423).
 *
 * The recovery path back to a batch's progress page: the submit toast's "View
 * progress" action is how a user normally gets there, and this is what is
 * left after dismissing it or reloading. Covers:
 *  - renders nothing while the list is empty (including on a failed lookup)
 *  - lists recent batches with their derived status/photo-count/relative time
 *  - the params + ready-to-review + failed summary line
 *  - clicking a batch card navigates to its own progress page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { RecentBatches } from '../../../pages/Enhancements/RecentBatches';
import type { EnhancementBatch } from '../../../services/enhance';

vi.mock('../../../services/enhance', () => ({
  listEnhancementBatches: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

import { listEnhancementBatches } from '../../../services/enhance';

const mockListEnhancementBatches = vi.mocked(listEnhancementBatches);

function makeBatch(overrides: Partial<EnhancementBatch> = {}): EnhancementBatch {
  return {
    id: 'batch-1',
    circleId: 'circle-1',
    status: 'running',
    matchedCount: 12,
    processedCount: 4,
    succeededCount: 3,
    failedCount: 0,
    skippedCount: 0,
    startedById: 'user-1',
    createdAt: '2026-08-01T11:58:00.000Z',
    updatedAt: '2026-08-01T11:59:00.000Z',
    startedAt: '2026-08-01T11:58:01.000Z',
    finishedAt: null,
    lastError: null,
    requestedCount: 12,
    queuedCount: 12,
    skipped: null,
    params: { preset: 'restore_old_photo', strength: 'strong' },
    source: 'selection',
    cancelledAt: null,
    ...overrides,
  };
}

describe('RecentBatches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing while there are no recent batches', async () => {
    mockListEnhancementBatches.mockResolvedValue({
      items: [],
      meta: { page: 1, pageSize: 5, totalItems: 0, totalPages: 0 },
    });

    const { container } = render(<RecentBatches circleId="circle-1" />);

    await waitFor(() => expect(mockListEnhancementBatches).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the lookup fails — this is a convenience list, never the reason the user is on the page', async () => {
    mockListEnhancementBatches.mockRejectedValue(new Error('network error'));

    const { container } = render(<RecentBatches circleId="circle-1" />);

    await waitFor(() => expect(mockListEnhancementBatches).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('requests the 5 most recent batches for the given circle', async () => {
    mockListEnhancementBatches.mockResolvedValue({
      items: [makeBatch()],
      meta: { page: 1, pageSize: 5, totalItems: 1, totalPages: 1 },
    });

    render(<RecentBatches circleId="circle-1" />);

    await waitFor(() => {
      expect(mockListEnhancementBatches).toHaveBeenCalledWith({
        circleId: 'circle-1',
        pageSize: 5,
      });
    });
  });

  it('lists a batch with its derived status, photo count, and relative time', async () => {
    mockListEnhancementBatches.mockResolvedValue({
      items: [makeBatch({ status: 'running', matchedCount: 12 })],
      meta: { page: 1, pageSize: 5, totalItems: 1, totalPages: 1 },
    });

    render(<RecentBatches circleId="circle-1" />);

    expect(await screen.findByText('Recent batches')).toBeInTheDocument();
    expect(screen.getByText('12 photos')).toBeInTheDocument();
    // runStatusLabel('running') -> 'Running'.
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('singularizes the photo count for exactly one photo', async () => {
    mockListEnhancementBatches.mockResolvedValue({
      items: [makeBatch({ matchedCount: 1 })],
      meta: { page: 1, pageSize: 5, totalItems: 1, totalPages: 1 },
    });

    render(<RecentBatches circleId="circle-1" />);

    expect(await screen.findByText('1 photo')).toBeInTheDocument();
  });

  it('summarises params plus ready-to-review and failed counts on one line', async () => {
    mockListEnhancementBatches.mockResolvedValue({
      items: [
        makeBatch({
          id: 'batch-1',
          params: { preset: 'restore_old_photo', strength: 'strong' },
          succeededCount: 4,
          failedCount: 2,
        }),
      ],
      meta: { page: 1, pageSize: 5, totalItems: 1, totalPages: 1 },
    });

    render(<RecentBatches circleId="circle-1" />);

    expect(
      await screen.findByText('restore old photo · strong · 4 ready to review · 2 failed'),
    ).toBeInTheDocument();
  });

  it('omits the ready-to-review/failed clauses when both are zero', async () => {
    mockListEnhancementBatches.mockResolvedValue({
      items: [
        makeBatch({
          id: 'batch-1',
          params: {},
          succeededCount: 0,
          failedCount: 0,
        }),
      ],
      meta: { page: 1, pageSize: 5, totalItems: 1, totalPages: 1 },
    });

    render(<RecentBatches circleId="circle-1" />);

    expect(await screen.findByText('auto')).toBeInTheDocument();
    expect(screen.queryByText(/ready to review/)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });

  it('navigates to the batch\'s own progress page when its card is clicked', async () => {
    const user = userEvent.setup();
    mockListEnhancementBatches.mockResolvedValue({
      items: [makeBatch({ id: 'batch-42' })],
      meta: { page: 1, pageSize: 5, totalItems: 1, totalPages: 1 },
    });

    render(<RecentBatches circleId="circle-1" />);

    const card = (await screen.findByText('12 photos')).closest(
      '.MuiCardActionArea-root',
    ) as HTMLElement;
    await user.click(within(card).getByText('12 photos'));

    expect(mockNavigate).toHaveBeenCalledWith('/enhancement-batches/batch-42');
  });

  it('lists multiple recent batches, each linking to its own page', async () => {
    const user = userEvent.setup();
    mockListEnhancementBatches.mockResolvedValue({
      items: [
        makeBatch({ id: 'batch-1', matchedCount: 5 }),
        makeBatch({ id: 'batch-2', matchedCount: 8, status: 'completed' }),
      ],
      meta: { page: 1, pageSize: 5, totalItems: 2, totalPages: 1 },
    });

    render(<RecentBatches circleId="circle-1" />);

    expect(await screen.findByText('5 photos')).toBeInTheDocument();
    expect(screen.getByText('8 photos')).toBeInTheDocument();

    const secondCard = screen
      .getByText('8 photos')
      .closest('.MuiCardActionArea-root') as HTMLElement;
    await user.click(within(secondCard).getByText('8 photos'));
    expect(mockNavigate).toHaveBeenCalledWith('/enhancement-batches/batch-2');
  });
});

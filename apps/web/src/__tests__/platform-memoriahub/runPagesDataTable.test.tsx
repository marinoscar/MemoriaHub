/**
 * The packaged run pages (`@marinoscar/memoriahub-web/review-runs/ui`) bind the
 * platform's real `DataTable` through the host's admin port. The package's own
 * specs render them against a plain-HTML fake table; this file keeps the checks
 * that only the real table can answer (docs/specs/datatable.md §18.4): the
 * failed-items table stays mounted across a poll tick, keeps a card expansion
 * the user opened, and shows live rows under a loading overlay.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '@marinoscar/platform-web/datatable/testing';
import { ReviewRunPage } from '@marinoscar/memoriahub-web/review-runs/ui';
import { render } from '../utils/test-utils';
import { api } from '../../services/api';

const RUN = {
  id: 'run-1',
  circleId: 'circle-1',
  subjectType: 'burst_group',
  action: 'resolve_archive',
  threshold: 60,
  status: 'completed_with_errors',
  matchedCount: 10,
  processedCount: 10,
  succeededCount: 8,
  failedCount: 2,
  skippedCount: 0,
  startedById: 'user-1',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  startedAt: '2025-01-01T00:00:00.000Z',
  finishedAt: '2025-01-01T00:01:00.000Z',
  lastError: null,
  itemStatusCounts: { failed: 2 },
};

function failedItem(id: string, filename: string) {
  return {
    id,
    subjectType: 'burst_group',
    subjectId: `bg-${id}`,
    status: 'failed',
    error: 'Resolve failed',
    updatedAt: '2025-01-01T00:00:00.000Z',
    media: { type: 'photo', capturedAt: null, filename, width: 10, height: 10 },
    thumbnailUrl: null,
  };
}

function renderPage() {
  return render(
    <Routes>
      <Route path="/review-runs/:runId" element={<ReviewRunPage />} />
    </Routes>,
    { wrapperOptions: { route: '/review-runs/run-1' } },
  );
}

beforeAll(() => {
  installLayoutStubs();
});

beforeEach(() => {
  resetContainerWidth(1400);
  vi.spyOn(api, 'get').mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('/review-runs/run-1/items')) {
      return {
        items: [failedItem('ri-1', 'broken-one.jpg'), failedItem('ri-2', 'broken-two.jpg')],
        meta: { page: 1, pageSize: 25, totalItems: 2, totalPages: 1 },
      } as never;
    }
    if (endpoint === '/review-runs/run-1') return RUN as never;
    return {} as never;
  });
  vi.spyOn(api, 'patch').mockResolvedValue({} as never);
});

describe('packaged run pages on the platform DataTable', () => {
  it('renders the failed items in the platform table with a named row action', async () => {
    renderPage();
    // The table is a lazy chunk: allow the first import to resolve.
    expect(await screen.findByText('broken-one.jpg', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByTestId('datatable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View for broken-one.jpg' })).toBeInTheDocument();
  });

  it('keeps a card expansion the user opened (phone-width container)', async () => {
    setInitialContainerWidth(400);
    renderPage();
    await screen.findByTestId('datatable', {}, { timeout: 8000 });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'More details for broken-one.jpg' }));
    expect(screen.getByTestId('datatable-card-detail-region')).toBeInTheDocument();
  });
});

/**
 * Tests for `NavContextPane` (issue #392, epic #388, spec §4.3).
 *
 * `CollectionsList` and `ReviewQueueList` are mocked as components — they each
 * have their own test file — so this file exercises exactly what belongs to
 * the pane itself: WHICH destination renders which list (or neither), and
 * that the resolved `activeKey` reaches the right one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { NavContextPane } from '../../../components/navigation/NavContextPane';

vi.mock('../../../components/collections/CollectionsList', () => ({
  CollectionsList: vi.fn(({ activeKey }: { activeKey: string | null }) => (
    <div data-testid="mock-collections-list" data-active-key={activeKey ?? ''}>
      Collections list
    </div>
  )),
}));
vi.mock('../../../components/review/ReviewQueueList', () => ({
  ReviewQueueList: vi.fn(({ activeKey }: { activeKey: string | null }) => (
    <div data-testid="mock-review-queue-list" data-active-key={activeKey ?? ''}>
      Review queue list
    </div>
  )),
}));

import { CollectionsList } from '../../../components/collections/CollectionsList';
import { ReviewQueueList } from '../../../components/review/ReviewQueueList';

const mockCollectionsList = vi.mocked(CollectionsList);
const mockReviewQueueList = vi.mocked(ReviewQueueList);

describe('NavContextPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Renders for Collections and Review, nothing for Photos / Search / Console
  // =========================================================================

  it('renders CollectionsList at a Collections-owned route (/albums)', () => {
    render(<NavContextPane />, { wrapperOptions: { route: '/albums' } });

    expect(screen.getByTestId('mock-collections-list')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-review-queue-list')).not.toBeInTheDocument();
  });

  it('renders ReviewQueueList at a Review-owned route (/bursts)', () => {
    render(<NavContextPane />, { wrapperOptions: { route: '/bursts' } });

    expect(screen.getByTestId('mock-review-queue-list')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-collections-list')).not.toBeInTheDocument();
  });

  it('renders nothing at the Photos destination (/)', () => {
    const { container } = render(<NavContextPane />, { wrapperOptions: { route: '/' } });

    expect(screen.queryByTestId('mock-collections-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-review-queue-list')).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing at the Search destination (/search)', () => {
    const { container } = render(<NavContextPane />, { wrapperOptions: { route: '/search' } });

    expect(container.firstChild).toBeNull();
  });

  it('renders nothing on an /admin/* (Console) route', () => {
    const { container } = render(<NavContextPane />, {
      wrapperOptions: { route: '/admin/settings/jobs' },
    });

    expect(container.firstChild).toBeNull();
  });

  it('renders nothing on a route owned by no destination (e.g. /settings)', () => {
    const { container } = render(<NavContextPane />, { wrapperOptions: { route: '/settings' } });

    expect(container.firstChild).toBeNull();
  });

  // =========================================================================
  // activeKey resolution — Review
  // =========================================================================

  describe('active key — Review', () => {
    it('resolves the queue key from the hub namespace (/review/duplicates)', () => {
      render(<NavContextPane />, { wrapperOptions: { route: '/review/duplicates' } });

      expect(mockReviewQueueList).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'pane', activeKey: 'duplicates' }),
        undefined,
      );
    });

    it('resolves the queue key from the original standalone route (/bursts)', () => {
      render(<NavContextPane />, { wrapperOptions: { route: '/bursts' } });

      expect(mockReviewQueueList).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'pane', activeKey: 'bursts' }),
        undefined,
      );
    });

    it('resolves null when on a Review-owned route that names no specific queue (/review)', () => {
      render(<NavContextPane />, { wrapperOptions: { route: '/review' } });

      expect(mockReviewQueueList).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'pane', activeKey: null }),
        undefined,
      );
    });

    it('resolves a queue key from a child route (/bursts/some-id)', () => {
      render(<NavContextPane />, { wrapperOptions: { route: '/bursts/some-id' } });

      expect(mockReviewQueueList).toHaveBeenCalledWith(
        expect.objectContaining({ activeKey: 'bursts' }),
        undefined,
      );
    });
  });

  // =========================================================================
  // activeKey resolution — Collections
  // =========================================================================

  describe('active key — Collections', () => {
    it('resolves "albums" at /albums', () => {
      render(<NavContextPane />, { wrapperOptions: { route: '/albums' } });

      expect(mockCollectionsList).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'pane', activeKey: 'albums' }),
        undefined,
      );
    });

    it('resolves "people" at /people', () => {
      render(<NavContextPane />, { wrapperOptions: { route: '/people' } });

      expect(mockCollectionsList).toHaveBeenCalledWith(
        expect.objectContaining({ activeKey: 'people' }),
        undefined,
      );
    });

    // NOTE: `/media` (with or without `?favorite=1`) is owned by the PHOTOS
    // destination (`config/destinations.ts`: `photos: ['/', '/media']`), not
    // Collections — `resolveActiveDestination` only ever sees `pathname`
    // (`/media`), never the query string. So standing on the Favorites link's
    // OWN target route, the pane's `destination` resolves to `'photos'` and
    // the pane renders NOTHING (Photos is single-surface, spec §4.3) — it
    // never reaches `resolveCollectionKey`'s query-string special case at
    // all. This looks like a real gap: pinning/opening Favorites from the
    // pane does not highlight it as active once you land there. Asserted
    // explicitly so a future fix (e.g. adding `/media` search-param handling
    // to route ownership) has a test to update rather than silently changing
    // behavior no test was watching.
    it('renders NOTHING at /media?favorite=1 — that route is owned by Photos, not Collections, so the favorites special case in resolveCollectionKey is unreached here', () => {
      const { container } = render(<NavContextPane />, {
        wrapperOptions: { route: '/media?favorite=1' },
      });

      expect(container.firstChild).toBeNull();
      expect(mockCollectionsList).not.toHaveBeenCalled();
    });

    it('renders nothing at plain /media either, for the same reason', () => {
      const { container } = render(<NavContextPane />, { wrapperOptions: { route: '/media' } });

      expect(container.firstChild).toBeNull();
    });

    it('resolves null on a Collections-owned route naming no specific entry (/collections)', () => {
      render(<NavContextPane />, { wrapperOptions: { route: '/collections' } });

      expect(mockCollectionsList).toHaveBeenCalledWith(
        expect.objectContaining({ activeKey: null }),
        undefined,
      );
    });
  });
});

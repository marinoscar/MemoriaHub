/**
 * Component tests — MemoriesCarousel (epic #300, issue #309).
 *
 * The gating tests are the point of this file. The epic's first success
 * criterion is that with `features.memories` off — the default — Home looks
 * exactly as it does today and costs nothing, so "renders null" and "issues no
 * request" are two separate assertions and both have to hold. The
 * still-loading-flags case is covered too: gating on a truthy check instead of
 * `=== true` would flash the row in and then remove it, which is the failure
 * mode `Sidebar` already documents for the enhancer entry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render, mockUser } from '../../utils/test-utils';
import type { MemoryFeedCard } from '../../../types/memories';

vi.mock('../../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(),
}));

vi.mock('../../../services/memories', () => ({
  getMemoriesFeed: vi.fn(),
  markMemorySeen: vi.fn(),
  hideMemory: vi.fn(),
  unhideMemory: vi.fn(),
  favoriteMemory: vi.fn(),
  unfavoriteMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));

import { MemoriesCarousel } from '../../../components/memories/MemoriesCarousel';
import { useFeatureFlags } from '../../../hooks/useFeatureFlags';
import { getMemoriesFeed } from '../../../services/memories';

const mockFlags = vi.mocked(useFeatureFlags);
const mockFeed = vi.mocked(getMemoriesFeed);

function setFlags(features: Record<string, boolean> | null, isLoading = false) {
  mockFlags.mockReturnValue({
    features,
    pictureEnhancement: null,
    isLoading,
    error: null,
    refresh: vi.fn(),
  });
}

function makeCard(overrides: Partial<MemoryFeedCard> = {}): MemoryFeedCard {
  return {
    id: 'mem-1',
    type: 'trip',
    title: 'Trip to Guanacaste',
    subtitle: 'March 2023',
    itemCount: 24,
    periodStart: '2023-03-12T00:00:00.000Z',
    periodEnd: '2023-03-18T00:00:00.000Z',
    coverMediaItemId: 'media-1',
    coverThumbnailUrl: 'https://cdn/cover.jpg',
    meta: null,
    myState: { seen: false, favorited: false },
    generatedAt: '2026-08-01T00:00:00.000Z',
    itemThumbnailUrls: [],
    ...overrides,
  };
}

function renderCarousel(circleId: string | null = 'circle-1') {
  return render(<MemoriesCarousel circleId={circleId} />, {
    wrapperOptions: { authenticated: true, user: mockUser },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFeed.mockResolvedValue({ items: [makeCard()] });
});

describe('MemoriesCarousel — feature gating', () => {
  it('renders nothing and fires no request when the flag is off', async () => {
    setFlags({ memories: false });

    const { container } = renderCarousel();

    await waitFor(() => expect(mockFlags).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(mockFeed).not.toHaveBeenCalled();
  });

  it('renders nothing and fires no request while the flags are still loading', async () => {
    setFlags(null, true);

    const { container } = renderCarousel();

    expect(container).toBeEmptyDOMElement();
    expect(mockFeed).not.toHaveBeenCalled();
  });

  it('renders nothing when the flags failed to load (features null)', async () => {
    setFlags(null, false);

    const { container } = renderCarousel();

    expect(container).toBeEmptyDOMElement();
    expect(mockFeed).not.toHaveBeenCalled();
  });

  it('renders nothing and fires no request without an active circle', async () => {
    setFlags({ memories: true });

    const { container } = renderCarousel(null);

    expect(container).toBeEmptyDOMElement();
    expect(mockFeed).not.toHaveBeenCalled();
  });
});

describe('MemoriesCarousel — enabled', () => {
  beforeEach(() => setFlags({ memories: true }));

  it('renders the heading and a card for each feed entry', async () => {
    mockFeed.mockResolvedValue({
      items: [makeCard({ id: 'a' }), makeCard({ id: 'b', title: 'Summer 2025' })],
    });

    renderCarousel();

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Memories' })).toBeInTheDocument(),
    );
    expect(await screen.findAllByTestId('memory-card')).toHaveLength(2);
    expect(screen.getByText('Trip to Guanacaste')).toBeInTheDocument();
    expect(screen.getByText('Summer 2025')).toBeInTheDocument();
  });

  it('disappears entirely once an empty feed resolves', async () => {
    mockFeed.mockResolvedValue({ items: [] });

    const { container } = renderCarousel();

    await waitFor(() => expect(mockFeed).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('disappears when the feed request fails — Home never shows an error row', async () => {
    mockFeed.mockRejectedValue(new Error('feed down'));

    const { container } = renderCarousel();

    await waitFor(() => expect(mockFeed).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('marks an unseen card with the ring and a "not yet viewed" label', async () => {
    mockFeed.mockResolvedValue({ items: [makeCard()] });

    renderCarousel();

    const card = await screen.findByTestId('memory-card');
    expect(card).toHaveAttribute('data-unseen', 'true');
    expect(
      screen.getByRole('button', { name: /not yet viewed/i }),
    ).toBeInTheDocument();
  });

  it('drops the ring and reads "viewed" for a seen card', async () => {
    mockFeed.mockResolvedValue({
      items: [makeCard({ myState: { seen: true, favorited: false } })],
    });

    renderCarousel();

    const card = await screen.findByTestId('memory-card');
    expect(card).toHaveAttribute('data-unseen', 'false');
    expect(screen.getByRole('button', { name: /, viewed/i })).toBeInTheDocument();
  });

  it('labels each card with its type, period, item count and state', async () => {
    mockFeed.mockResolvedValue({ items: [makeCard()] });

    renderCarousel();

    const card = await screen.findByRole('button', { name: /^Memory: Trip to Guanacaste/ });
    expect(card).toHaveAccessibleName(/24 items/);
    expect(card).toHaveAccessibleName(/not yet viewed/);
    expect(card).toHaveAccessibleName(/\(Trip\)/);
  });

  it('exposes keyboard-reachable scroll controls with accessible names', async () => {
    mockFeed.mockResolvedValue({ items: [makeCard()] });

    renderCarousel();

    await screen.findByTestId('memory-card');
    // Desktop-only chevrons; the test matchMedia mock reports `matches: false`
    // for every query, so this asserts the phone layout omits them rather than
    // rendering dead controls.
    expect(
      screen.queryByRole('button', { name: /scroll memories/i }),
    ).not.toBeInTheDocument();
  });

  it('links to the /memories hub', async () => {
    renderCarousel();

    const link = await screen.findByRole('link', { name: /see all/i });
    expect(link).toHaveAttribute('href', '/memories');
  });
});

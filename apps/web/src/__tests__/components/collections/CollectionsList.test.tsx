/**
 * Tests for CollectionsList (issue #391, spec §4.6).
 *
 * The Collections analogue of `ReviewQueueList.test.tsx`: this component
 * renders `useCollectionSummaries()` (the real hook), so the SERVICE layer is
 * mocked rather than the hook — mirrors `Sidebar.test.tsx` /
 * `ReviewHubPage.test.tsx` — letting each case assert what was actually
 * requested and rendered from real data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { CollectionsList } from '../../../components/collections/CollectionsList';
import CollectionsHubPage from '../../../pages/Collections/CollectionsHubPage';
import { COLLECTIONS } from '../../../config/collections';
import { formatCollectionCount, collectionAccessibleName } from '../../../components/collections/CollectionsList';
import type { Album, AlbumListResponse } from '../../../types/media';
import type { PersonListResponse } from '../../../services/face';
import type { ExploreLocations } from '../../../services/media';
import type { MemoryCard, MemoryListResponse } from '../../../types/memories';

vi.mock('../../../services/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/media')>()),
  listAlbums: vi.fn(),
  getExploreLocations: vi.fn(),
}));
vi.mock('../../../services/face', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/face')>()),
  listPeople: vi.fn(),
}));
vi.mock('../../../services/memories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/memories')>()),
  listMemories: vi.fn(),
}));
vi.mock('../../../hooks/useMemoriesEnabled', () => ({
  useMemoriesEnabled: vi.fn(),
}));

import { listAlbums, getExploreLocations } from '../../../services/media';
import { listPeople } from '../../../services/face';
import { listMemories } from '../../../services/memories';
import { useMemoriesEnabled } from '../../../hooks/useMemoriesEnabled';

const mockListAlbums = vi.mocked(listAlbums);
const mockListPeople = vi.mocked(listPeople);
const mockGetExploreLocations = vi.mocked(getExploreLocations);
const mockListMemories = vi.mocked(listMemories);
const mockUseMemoriesEnabled = vi.mocked(useMemoriesEnabled);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function album(overrides: Partial<Album> = {}): Album {
  return {
    id: 'album-1',
    name: 'Album',
    description: null,
    addedById: 'user-1',
    circleId: 'circle-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    coverThumbnailUrl: 'https://x/album-cover.jpg',
    ...overrides,
  };
}

function albumsResponse(overrides: Partial<AlbumListResponse> = {}): AlbumListResponse {
  return {
    items: [album()],
    meta: { page: 1, pageSize: 4, totalItems: 24, totalPages: 6 },
    ...overrides,
  };
}

function peopleResponse(overrides: Partial<PersonListResponse> = {}): PersonListResponse {
  return {
    items: [],
    meta: { page: 1, pageSize: 4, totalItems: 1, totalPages: 1 },
    ...overrides,
  };
}

function placesResponse(overrides: Partial<ExploreLocations> = {}): ExploreLocations {
  return {
    countries: [],
    regions: [],
    cities: [{ name: 'Heredia', countryCode: 'CR', count: 3, coverThumbnailUrl: null }],
    ...overrides,
  };
}

function memoryCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  return {
    id: `memory-${Math.random()}`,
    type: 'on_this_day',
    title: 'A memory',
    subtitle: null,
    itemCount: 3,
    periodStart: '2020-01-01T00:00:00.000Z',
    periodEnd: '2020-01-01T00:00:00.000Z',
    coverMediaItemId: null,
    coverThumbnailUrl: null,
    meta: null,
    myState: { seen: false, favorited: false },
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function memoriesResponse(overrides: Partial<MemoryListResponse> = {}): MemoryListResponse {
  const items = Array.from({ length: 50 }, () => memoryCard());
  return {
    items,
    meta: { pageSize: 50, nextCursor: 'cursor-1', hasMore: true },
    ...overrides,
  };
}

describe('CollectionsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMemoriesEnabled.mockReturnValue(true);
    mockListAlbums.mockResolvedValue(albumsResponse());
    mockListPeople.mockResolvedValue(peopleResponse());
    mockGetExploreLocations.mockResolvedValue(placesResponse());
    mockListMemories.mockResolvedValue(memoriesResponse());
  });

  // =========================================================================
  // Order and grouping
  // =========================================================================

  it('renders entries in registry order, with a divider between primary and secondary', () => {
    const { container } = render(<CollectionsList />);

    const rows = Array.from(container.querySelectorAll('.MuiListItemButton-root')).map(
      (el) => el.getAttribute('aria-label'),
    );
    const expectedOrder = COLLECTIONS.map((c) => c.label);
    // Compare by label prefix (aria-label starts with the entry's label).
    expect(rows.map((r) => expectedOrder.find((label) => r?.startsWith(label)))).toEqual(
      expectedOrder,
    );

    // Exactly one divider, and it sits after the five primary rows.
    const divider = container.querySelector('.MuiDivider-root');
    expect(divider).not.toBeNull();

    const primaryCount = COLLECTIONS.filter((c) => c.group === 'primary').length;
    const allButtons = Array.from(container.querySelectorAll('.MuiListItemButton-root'));
    const dividerIndexInDom = Array.from(container.querySelectorAll('*')).indexOf(divider!);
    const lastPrimaryButtonIndex = Array.from(container.querySelectorAll('*')).indexOf(
      allButtons[primaryCount - 1],
    );
    const firstSecondaryButtonIndex = Array.from(container.querySelectorAll('*')).indexOf(
      allButtons[primaryCount],
    );
    expect(dividerIndexInDom).toBeGreaterThan(lastPrimaryButtonIndex);
    expect(dividerIndexInDom).toBeLessThan(firstSecondaryButtonIndex);
  });

  // =========================================================================
  // Count formatting
  // =========================================================================

  describe('count formatting', () => {
    it('formatCollectionCount renders an exact count as the bare number', () => {
      expect(formatCollectionCount({ value: 24, approximate: false })).toBe('24');
    });

    it('formatCollectionCount renders an approximate count with a trailing +', () => {
      expect(formatCollectionCount({ value: 50, approximate: true })).toBe('50+');
    });

    it('renders the Albums count "24" in the list', async () => {
      render(<CollectionsList />);
      expect(await screen.findByText('24')).toBeInTheDocument();
    });

    it('renders the Memories count "50+" in the list', async () => {
      render(<CollectionsList />);
      expect(await screen.findByText('50+')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Accessible names
  // =========================================================================

  describe('accessible names', () => {
    it('collectionAccessibleName reads "Albums, 24 items" for a plural exact count', () => {
      const albumsEntry = COLLECTIONS.find((c) => c.key === 'albums')!;
      expect(collectionAccessibleName(albumsEntry, { value: 24, approximate: false })).toBe(
        'Albums, 24 items',
      );
    });

    it('collectionAccessibleName reads "Albums, 1 item" (singular) for an exact count of 1', () => {
      const albumsEntry = COLLECTIONS.find((c) => c.key === 'albums')!;
      expect(collectionAccessibleName(albumsEntry, { value: 1, approximate: false })).toBe(
        'Albums, 1 item',
      );
    });

    it('collectionAccessibleName reads "Memories, 50 or more items" for an approximate count — worded, not "50+"', () => {
      const memoriesEntry = COLLECTIONS.find((c) => c.key === 'memories')!;
      expect(collectionAccessibleName(memoriesEntry, { value: 50, approximate: true })).toBe(
        'Memories, 50 or more items',
      );
      // The visible "+" glyph must never appear in the accessible name — a
      // screen reader cannot be relied on to announce it.
      expect(
        collectionAccessibleName(memoriesEntry, { value: 50, approximate: true }),
      ).not.toContain('+');
    });

    it('the rendered People row carries the singular accessible name', async () => {
      render(<CollectionsList />);
      expect(await screen.findByRole('link', { name: 'People, 1 item' })).toBeInTheDocument();
    });

    it('the rendered Memories row carries the worded approximate accessible name', async () => {
      render(<CollectionsList />);
      expect(
        await screen.findByRole('link', { name: 'Memories, 50 or more items' }),
      ).toBeInTheDocument();
    });

    it('a sourceless entry (Map) carries just its label, no count phrase', async () => {
      render(<CollectionsList />);
      expect(await screen.findByRole('link', { name: 'Map' })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Real links, keyboard-focusable
  // =========================================================================

  describe('rows are real links', () => {
    it('every row has the correct href', async () => {
      render(<CollectionsList />);

      for (const entry of COLLECTIONS) {
        const links = await screen.findAllByRole('link');
        const match = links.find((el) => el.getAttribute('href') === entry.path);
        expect(match, `no link found with href="${entry.path}" for ${entry.key}`).toBeDefined();
      }
    });

    it('a row is keyboard-focusable', async () => {
      render(<CollectionsList />);
      const albumsLink = await screen.findByRole('link', { name: /Albums/ });
      albumsLink.focus();
      expect(albumsLink).toHaveFocus();
    });
  });

  // =========================================================================
  // Memories gating — and the grid must hide it from the SAME check
  // =========================================================================

  describe('Memories gating (shared with the card grid)', () => {
    it('hides Memories from the list when useMemoriesEnabled() is not true', async () => {
      mockUseMemoriesEnabled.mockReturnValue(false);
      render(<CollectionsList />);

      // Give the other three sources a chance to resolve so the list has
      // settled before asserting an absence.
      expect(await screen.findByRole('link', { name: /Albums/ })).toBeInTheDocument();
      expect(screen.queryByText('Memories')).not.toBeInTheDocument();
    });

    it('hides Memories from BOTH the list and the card grid from the same flag check, so the two surfaces cannot drift', async () => {
      mockUseMemoriesEnabled.mockReturnValue(false);

      render(
        <>
          <CollectionsList />
          <CollectionsHubPage />
        </>,
      );

      // Both surfaces have rendered real content (proving they mounted and
      // resolved, not just that neither rendered at all).
      expect((await screen.findAllByText('Albums')).length).toBeGreaterThan(0);
      expect(screen.queryByText('Memories')).not.toBeInTheDocument();
    });

    it('shows Memories in both surfaces once the flag resolves true', async () => {
      mockUseMemoriesEnabled.mockReturnValue(true);

      render(
        <>
          <CollectionsList />
          <CollectionsHubPage />
        </>,
      );

      const memoriesOccurrences = await screen.findAllByText('Memories');
      // One in the list row, one in the grid card.
      expect(memoriesOccurrences.length).toBe(2);
    });
  });
});

/**
 * Tests for useCollectionSummaries (issue #391, spec §4.6 / §6.1).
 *
 * THE LOAD-BEARING PROPERTY under test is INDEPENDENCE — see the hook's own
 * module doc: four sources fire in parallel, are stored in four separate
 * state slots, and settle (or fail) one at a time. A `Promise.all`
 * implementation would satisfy "each source populates its own summary" below
 * while silently failing the independence cases — that is deliberate, so a
 * future refactor toward `Promise.all` fails loudly here rather than only in
 * a slow-network bug report.
 *
 * Mocks the SERVICE layer (services/media, services/face, services/memories)
 * plus the two small hooks (`useCircle`, `useMemoriesEnabled`) the hook reads
 * directly, rather than mocking `useCollectionSummaries` itself — mirrors
 * `Sidebar.test.tsx` / `ReviewHubPage.test.tsx`, so each case can assert what
 * was actually requested.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCollectionSummaries } from '../../hooks/useCollectionSummaries';
import type { Album, AlbumListResponse } from '../../types/media';
import type { PersonListResponse } from '../../services/face';
import type { ExploreLocations } from '../../services/media';
import type { MemoryCard, MemoryListResponse } from '../../types/memories';
import type { Circle } from '../../types/circles';

vi.mock('../../services/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/media')>()),
  listAlbums: vi.fn(),
  getExploreLocations: vi.fn(),
}));
vi.mock('../../services/face', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/face')>()),
  listPeople: vi.fn(),
}));
vi.mock('../../services/memories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/memories')>()),
  listMemories: vi.fn(),
}));
vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));
vi.mock('../../hooks/useMemoriesEnabled', () => ({
  useMemoriesEnabled: vi.fn(),
}));

import { listAlbums, getExploreLocations } from '../../services/media';
import { listPeople } from '../../services/face';
import { listMemories } from '../../services/memories';
import { useCircle } from '../../hooks/useCircle';
import { useMemoriesEnabled } from '../../hooks/useMemoriesEnabled';

const mockListAlbums = vi.mocked(listAlbums);
const mockListPeople = vi.mocked(listPeople);
const mockGetExploreLocations = vi.mocked(getExploreLocations);
const mockListMemories = vi.mocked(listMemories);
const mockUseCircle = vi.mocked(useCircle);
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
    coverThumbnailUrl: null,
    ...overrides,
  };
}

function albumsResponse(overrides: Partial<AlbumListResponse> = {}): AlbumListResponse {
  return {
    items: [],
    meta: { page: 1, pageSize: 4, totalItems: 0, totalPages: 0 },
    ...overrides,
  };
}

function peopleResponse(overrides: Partial<PersonListResponse> = {}): PersonListResponse {
  return {
    items: [],
    meta: { page: 1, pageSize: 4, totalItems: 0, totalPages: 0 },
    ...overrides,
  };
}

function placesResponse(overrides: Partial<ExploreLocations> = {}): ExploreLocations {
  return { countries: [], regions: [], cities: [], ...overrides };
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
  return {
    items: [],
    meta: { pageSize: 50, nextCursor: null, hasMore: false },
    ...overrides,
  };
}

function circleState(activeCircleId: string | null) {
  return {
    circles: [] as Circle[],
    activeCircle: null,
    activeCircleId,
    activeCircleRole: null,
    loading: false,
    setActiveCircle: vi.fn(),
    refreshCircles: vi.fn(),
  };
}

describe('useCollectionSummaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCircle.mockReturnValue(circleState('circle-1'));
    mockUseMemoriesEnabled.mockReturnValue(true);
    mockListAlbums.mockResolvedValue(albumsResponse());
    mockListPeople.mockResolvedValue(peopleResponse());
    mockGetExploreLocations.mockResolvedValue(placesResponse());
    mockListMemories.mockResolvedValue(memoriesResponse());
  });

  // =========================================================================
  // Each source populates its own summary from its own service call
  // =========================================================================

  it('populates each summary from its own service call', async () => {
    mockListAlbums.mockResolvedValue(
      albumsResponse({
        items: [album({ coverThumbnailUrl: 'https://x/a.jpg' })],
        meta: { page: 1, pageSize: 4, totalItems: 24, totalPages: 6 },
      }),
    );
    mockListPeople.mockResolvedValue(
      peopleResponse({ meta: { page: 1, pageSize: 4, totalItems: 5, totalPages: 2 } }),
    );
    mockGetExploreLocations.mockResolvedValue(
      placesResponse({
        cities: [{ name: 'Heredia', countryCode: 'CR', count: 12, coverThumbnailUrl: 'https://x/c.jpg' }],
      }),
    );
    mockListMemories.mockResolvedValue(
      memoriesResponse({
        items: [memoryCard(), memoryCard()],
        meta: { pageSize: 50, nextCursor: null, hasMore: false },
      }),
    );

    const { result } = renderHook(() => useCollectionSummaries());

    await waitFor(() => {
      expect(result.current.summaries.albums.status).toBe('ready');
      expect(result.current.summaries.people.status).toBe('ready');
      expect(result.current.summaries.places.status).toBe('ready');
      expect(result.current.summaries.memories.status).toBe('ready');
    });

    expect(result.current.summaries.albums.count).toEqual({ value: 24, approximate: false });
    expect(result.current.summaries.people.count).toEqual({ value: 5, approximate: false });
    expect(result.current.summaries.places.count).toEqual({ value: 1, approximate: false });
    expect(result.current.summaries.memories.count).toEqual({ value: 2, approximate: false });

    expect(mockListAlbums).toHaveBeenCalledWith(expect.objectContaining({ circleId: 'circle-1' }));
    expect(mockListPeople).toHaveBeenCalledWith('circle-1', expect.anything());
    expect(mockGetExploreLocations).toHaveBeenCalledWith('circle-1');
    expect(mockListMemories).toHaveBeenCalledWith(expect.objectContaining({ circleId: 'circle-1' }));
  });

  // =========================================================================
  // Independence — the whole point of this hook
  // =========================================================================

  describe('independence between sources', () => {
    it('a rejected source does not stop the other three from reaching "ready"', async () => {
      mockListPeople.mockRejectedValue(new Error('people endpoint down'));

      const { result } = renderHook(() => useCollectionSummaries());

      await waitFor(() => {
        expect(result.current.summaries.people.status).toBe('error');
        expect(result.current.summaries.albums.status).toBe('ready');
        expect(result.current.summaries.places.status).toBe('ready');
        expect(result.current.summaries.memories.status).toBe('ready');
      });
    });

    it('a source that never settles does not block the other three from reaching "ready" — proves there is no Promise.all', async () => {
      // Deliberately never resolves or rejects.
      mockGetExploreLocations.mockReturnValue(new Promise<ExploreLocations>(() => {}));

      const { result } = renderHook(() => useCollectionSummaries());

      await waitFor(() => {
        expect(result.current.summaries.albums.status).toBe('ready');
        expect(result.current.summaries.people.status).toBe('ready');
        expect(result.current.summaries.memories.status).toBe('ready');
      });

      // The hung source is still loading — if a `Promise.all` (or any other
      // joined wait) were in play, the whole state update would still be
      // pending too, and the assertions above would have timed out instead.
      expect(result.current.summaries.places.status).toBe('loading');
    });
  });

  // =========================================================================
  // A rejected source degrades to its own error state — never throws
  // =========================================================================

  it('a rejected source ends at status "error" with count null and empty covers, and the hook never throws', async () => {
    mockListAlbums.mockRejectedValue(new Error('boom'));

    expect(() => renderHook(() => useCollectionSummaries())).not.toThrow();

    const { result } = renderHook(() => useCollectionSummaries());

    await waitFor(() => expect(result.current.summaries.albums.status).toBe('error'));

    expect(result.current.summaries.albums.count).toBeNull();
    expect(result.current.summaries.albums.coverUrls).toEqual([]);
    expect(result.current.summaries.albums.people).toEqual([]);
  });

  // =========================================================================
  // Memories count — exact vs. approximate, and never inflated by page size
  // =========================================================================

  describe('memories count', () => {
    it('is exact ({approximate:false}) when hasMore is false', async () => {
      mockListMemories.mockResolvedValue(
        memoriesResponse({
          items: [memoryCard(), memoryCard(), memoryCard()],
          meta: { pageSize: 50, nextCursor: null, hasMore: false },
        }),
      );

      const { result } = renderHook(() => useCollectionSummaries());

      await waitFor(() => expect(result.current.summaries.memories.status).toBe('ready'));
      expect(result.current.summaries.memories.count).toEqual({ value: 3, approximate: false });
    });

    it('is a floor ({approximate:true}) when hasMore is true', async () => {
      const items = Array.from({ length: 50 }, () => memoryCard());
      mockListMemories.mockResolvedValue(
        memoriesResponse({ items, meta: { pageSize: 50, nextCursor: 'cursor-1', hasMore: true } }),
      );

      const { result } = renderHook(() => useCollectionSummaries());

      await waitFor(() => expect(result.current.summaries.memories.status).toBe('ready'));
      expect(result.current.summaries.memories.count).toEqual({ value: 50, approximate: true });
    });

    it('value comes from items.length, never the requested page size, when the server returns fewer than asked', async () => {
      // Requested pageSize is 50 (module constant), but the server returns
      // only 2 items with hasMore:false — the count must be 2, not 50.
      mockListMemories.mockResolvedValue(
        memoriesResponse({
          items: [memoryCard(), memoryCard()],
          meta: { pageSize: 50, nextCursor: null, hasMore: false },
        }),
      );

      const { result } = renderHook(() => useCollectionSummaries());

      await waitFor(() => expect(result.current.summaries.memories.status).toBe('ready'));
      expect(result.current.summaries.memories.count!.value).toBe(2);
    });
  });

  // =========================================================================
  // Memories request gating on the flag
  // =========================================================================

  describe('memories flag gating', () => {
    it.each([false, null] as const)(
      'does not call listMemories when useMemoriesEnabled() is %s',
      async (flagValue) => {
        mockUseMemoriesEnabled.mockReturnValue(flagValue);

        renderHook(() => useCollectionSummaries());

        await waitFor(() => expect(mockListAlbums).toHaveBeenCalled());
        expect(mockListMemories).not.toHaveBeenCalled();
      },
    );

    it('calls listMemories when useMemoriesEnabled() === true', async () => {
      mockUseMemoriesEnabled.mockReturnValue(true);

      renderHook(() => useCollectionSummaries());

      await waitFor(() => expect(mockListMemories).toHaveBeenCalled());
    });

    it('excludes the memories entry from `entries` when the flag is not true', () => {
      mockUseMemoriesEnabled.mockReturnValue(false);

      const { result } = renderHook(() => useCollectionSummaries());

      expect(result.current.entries.some((e) => e.key === 'memories')).toBe(false);
    });

    it('includes the memories entry in `entries` when the flag is true', () => {
      mockUseMemoriesEnabled.mockReturnValue(true);

      const { result } = renderHook(() => useCollectionSummaries());

      expect(result.current.entries.some((e) => e.key === 'memories')).toBe(true);
    });
  });

  // =========================================================================
  // No active circle
  // =========================================================================

  describe('no active circle', () => {
    it('issues no request to any of the four sources', async () => {
      mockUseCircle.mockReturnValue(circleState(null));

      renderHook(() => useCollectionSummaries());

      // Flush any pending microtasks/effects without relying on a call that
      // will never happen.
      await new Promise((r) => setTimeout(r, 0));

      expect(mockListAlbums).not.toHaveBeenCalled();
      expect(mockListPeople).not.toHaveBeenCalled();
      expect(mockGetExploreLocations).not.toHaveBeenCalled();
      expect(mockListMemories).not.toHaveBeenCalled();
    });

    it('resolves every summary to ready/no-count rather than leaving them stuck loading', () => {
      mockUseCircle.mockReturnValue(circleState(null));

      const { result } = renderHook(() => useCollectionSummaries());

      expect(result.current.summaries.albums).toEqual({
        status: 'ready',
        coverUrls: [],
        people: [],
        count: null,
      });
      expect(result.current.summaries.people.status).toBe('ready');
      expect(result.current.summaries.places.status).toBe('ready');
      expect(result.current.summaries.memories.status).toBe('ready');
    });
  });

  // =========================================================================
  // Switching circles refetches
  // =========================================================================

  it('refetches every source when the active circle changes', async () => {
    const { rerender } = renderHook(() => useCollectionSummaries());

    await waitFor(() => expect(mockListAlbums).toHaveBeenCalledTimes(1));
    expect(mockListAlbums).toHaveBeenCalledWith(expect.objectContaining({ circleId: 'circle-1' }));

    mockUseCircle.mockReturnValue(circleState('circle-2'));
    rerender();

    await waitFor(() => expect(mockListAlbums).toHaveBeenCalledTimes(2));
    expect(mockListAlbums).toHaveBeenLastCalledWith(expect.objectContaining({ circleId: 'circle-2' }));
    expect(mockListPeople).toHaveBeenLastCalledWith('circle-2', expect.anything());
    expect(mockGetExploreLocations).toHaveBeenLastCalledWith('circle-2');
    expect(mockListMemories).toHaveBeenLastCalledWith(expect.objectContaining({ circleId: 'circle-2' }));
  });

  // =========================================================================
  // Generation guard — a stale response landing after a circle switch is
  // discarded, driven by actually resolving a stale in-flight promise after
  // the switch rather than merely asserting the request args.
  // =========================================================================

  it('discards a response that resolves after the active circle has already switched away', async () => {
    let resolveStale!: (v: AlbumListResponse) => void;
    const stalePromise = new Promise<AlbumListResponse>((res) => {
      resolveStale = res;
    });

    // First call (circle-1) hangs; second call (circle-2) resolves promptly.
    mockListAlbums
      .mockImplementationOnce(() => stalePromise)
      .mockResolvedValueOnce(
        albumsResponse({ items: [], meta: { page: 1, pageSize: 4, totalItems: 99, totalPages: 25 } }),
      );

    const { result, rerender } = renderHook(() => useCollectionSummaries());

    // circle-1's albums call is now in flight and will not resolve for a while.
    expect(result.current.summaries.albums.status).toBe('loading');

    // Switch circles before the stale promise resolves.
    mockUseCircle.mockReturnValue(circleState('circle-2'));
    rerender();

    await waitFor(() =>
      expect(result.current.summaries.albums.count).toEqual({ value: 99, approximate: false }),
    );

    // Now let the stale circle-1 response land.
    resolveStale(
      albumsResponse({ items: [], meta: { page: 1, pageSize: 4, totalItems: 1, totalPages: 1 } }),
    );
    await new Promise((r) => setTimeout(r, 0));

    // Still circle-2's data — the stale response from circle-1 never overwrote it.
    expect(result.current.summaries.albums.count).toEqual({ value: 99, approximate: false });
  });
});

/**
 * Unit tests for useUnassignedFaces.
 *
 * Mirrors the pattern of usePeople.test.ts, but note a key behavioral
 * difference from usePeople's hide/unhide/purge: this hook's hide/unhide/purge
 * do NOT auto-refresh internally and do NOT throw on a null circleId — they
 * silently no-op and resolve with a zeroed result. Callers (PeoplePage) are
 * responsible for calling refresh() themselves after a mutation.
 *
 * Note: refresh() (and the mount-triggered initial load) always fetches
 * page:1 explicitly now — `listUnassignedFaces(circleId, { page: 1, pageSize, archived })`.
 * loadMore() fetches the next page and appends results, deduping on faceId.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock the face service module
// ---------------------------------------------------------------------------

vi.mock('../../services/face', () => ({
  listUnassignedFaces: vi.fn(),
  bulkHideFaces: vi.fn(),
  bulkUnhideFaces: vi.fn(),
  purgeFaces: vi.fn(),
  purgeArchivedFaces: vi.fn(),
}));

import {
  listUnassignedFaces,
  bulkHideFaces,
  bulkUnhideFaces,
  purgeFaces,
  purgeArchivedFaces,
} from '../../services/face';
import type { UnassignedFacesResponse, UnassignedFaceDto } from '../../services/face';
import { useUnassignedFaces } from '../../hooks/useUnassignedFaces';

const mockListUnassignedFaces = vi.mocked(listUnassignedFaces);
const mockBulkHideFaces = vi.mocked(bulkHideFaces);
const mockBulkUnhideFaces = vi.mocked(bulkUnhideFaces);
const mockPurgeFaces = vi.mocked(purgeFaces);
const mockPurgeArchivedFaces = vi.mocked(purgeArchivedFaces);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFace(faceId: string): UnassignedFaceDto {
  return {
    faceId,
    mediaItemId: 'media-1',
    boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    faceThumbnailUrl: null,
    hiddenAt: null,
  };
}

function makeUnassignedFacesResponse(
  overrides: Partial<UnassignedFacesResponse> = {},
): UnassignedFacesResponse {
  return {
    items: [makeFace('face-1')],
    meta: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: initial load / archived option
// ---------------------------------------------------------------------------

describe('useUnassignedFaces — initial load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls listUnassignedFaces on mount with page:1, pageSize:50 and archived:false by default', async () => {
    mockListUnassignedFaces.mockResolvedValue(makeUnassignedFacesResponse());

    renderHook(() => useUnassignedFaces('circle-1'));

    await waitFor(() => {
      expect(mockListUnassignedFaces).toHaveBeenCalledWith('circle-1', {
        page: 1,
        pageSize: 50,
        archived: false,
      });
    });
  });

  it('passes archived:true when opts.archived is true', async () => {
    mockListUnassignedFaces.mockResolvedValue(makeUnassignedFacesResponse());

    renderHook(() => useUnassignedFaces('circle-1', { archived: true }));

    await waitFor(() => {
      expect(mockListUnassignedFaces).toHaveBeenCalledWith('circle-1', {
        page: 1,
        pageSize: 50,
        archived: true,
      });
    });
  });

  it('populates faces after successful load', async () => {
    const response = makeUnassignedFacesResponse();
    mockListUnassignedFaces.mockResolvedValue(response);

    const { result } = renderHook(() => useUnassignedFaces('circle-1'));

    await waitFor(() => {
      expect(result.current.faces).toEqual(response.items);
    });
  });

  it('starts with faces empty and loading false', () => {
    mockListUnassignedFaces.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useUnassignedFaces('circle-1'));

    expect(result.current.faces).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('does not call listUnassignedFaces when circleId is null, and faces stays empty', () => {
    mockListUnassignedFaces.mockResolvedValue(makeUnassignedFacesResponse());

    const { result } = renderHook(() => useUnassignedFaces(null));

    expect(mockListUnassignedFaces).not.toHaveBeenCalled();
    expect(result.current.faces).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: loading / error states
// ---------------------------------------------------------------------------

describe('useUnassignedFaces — loading and error states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets loading=true while fetching and false after', async () => {
    let resolveList!: (v: UnassignedFacesResponse) => void;
    const deferred = new Promise<UnassignedFacesResponse>((res) => { resolveList = res; });
    mockListUnassignedFaces.mockReturnValue(deferred);

    const { result } = renderHook(() => useUnassignedFaces('circle-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });

    await act(async () => {
      resolveList(makeUnassignedFacesResponse());
      await deferred;
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
  });

  it('sets error message when listUnassignedFaces rejects with Error', async () => {
    mockListUnassignedFaces.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useUnassignedFaces('circle-1'));

    await waitFor(() => {
      expect(result.current.error).toBe('Network error');
    });
  });

  it('sets fallback error message when listUnassignedFaces rejects with a non-Error', async () => {
    mockListUnassignedFaces.mockRejectedValue('plain string error');

    const { result } = renderHook(() => useUnassignedFaces('circle-1'));

    await waitFor(() => {
      expect(result.current.error).toBe('Failed to load unassigned faces');
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: refresh()
// ---------------------------------------------------------------------------

describe('useUnassignedFaces — refresh()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refresh() re-fetches page 1 with the same archived option', async () => {
    mockListUnassignedFaces.mockResolvedValue(makeUnassignedFacesResponse());

    const { result } = renderHook(() => useUnassignedFaces('circle-1', { archived: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockListUnassignedFaces).toHaveBeenCalledTimes(2);
    expect(mockListUnassignedFaces).toHaveBeenLastCalledWith('circle-1', {
      page: 1,
      pageSize: 50,
      archived: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: total / hasMore
// ---------------------------------------------------------------------------

describe('useUnassignedFaces — total / hasMore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('populates total from meta.totalItems', async () => {
    mockListUnassignedFaces.mockResolvedValue(
      makeUnassignedFacesResponse({
        meta: { page: 1, pageSize: 50, totalItems: 137, totalPages: 3 },
      }),
    );

    const { result } = renderHook(() => useUnassignedFaces('circle-1'));

    await waitFor(() => {
      expect(result.current.total).toBe(137);
    });
  });

  it('hasMore is true when faces.length < total', async () => {
    mockListUnassignedFaces.mockResolvedValue(
      makeUnassignedFacesResponse({
        items: [makeFace('face-1')],
        meta: { page: 1, pageSize: 50, totalItems: 5, totalPages: 1 },
      }),
    );

    const { result } = renderHook(() => useUnassignedFaces('circle-1'));

    await waitFor(() => {
      expect(result.current.hasMore).toBe(true);
    });
  });

  it('hasMore is false when faces.length equals total', async () => {
    mockListUnassignedFaces.mockResolvedValue(
      makeUnassignedFacesResponse({
        items: [makeFace('face-1')],
        meta: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 },
      }),
    );

    const { result } = renderHook(() => useUnassignedFaces('circle-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadMore()
// ---------------------------------------------------------------------------

describe('useUnassignedFaces — loadMore()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches page 2 and appends results, deduping overlapping faceIds', async () => {
    mockListUnassignedFaces.mockResolvedValueOnce(
      makeUnassignedFacesResponse({
        items: [makeFace('face-1'), makeFace('face-2')],
        meta: { page: 1, pageSize: 2, totalItems: 3, totalPages: 2 },
      }),
    );

    const { result } = renderHook(() => useUnassignedFaces('circle-1', { pageSize: 2 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.faces.map((f) => f.faceId)).toEqual(['face-1', 'face-2']);

    // Page 2 response overlaps face-2 (already loaded) plus a genuinely new face-3.
    mockListUnassignedFaces.mockResolvedValueOnce(
      makeUnassignedFacesResponse({
        items: [makeFace('face-2'), makeFace('face-3')],
        meta: { page: 2, pageSize: 2, totalItems: 3, totalPages: 2 },
      }),
    );

    await act(async () => {
      await result.current.loadMore();
    });

    expect(mockListUnassignedFaces).toHaveBeenLastCalledWith('circle-1', {
      page: 2,
      pageSize: 2,
      archived: false,
    });

    // Deduped: face-2 must not appear twice.
    expect(result.current.faces.map((f) => f.faceId)).toEqual(['face-1', 'face-2', 'face-3']);
    expect(result.current.total).toBe(3);
  });

  it('does not call the service when circleId is null', async () => {
    const { result } = renderHook(() => useUnassignedFaces(null));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(mockListUnassignedFaces).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: hide()
// ---------------------------------------------------------------------------

describe('useUnassignedFaces — hide()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls bulkHideFaces with circleId and ids', async () => {
    mockListUnassignedFaces.mockResolvedValue(makeUnassignedFacesResponse());
    mockBulkHideFaces.mockResolvedValue({ hidden: 1 });

    const { result } = renderHook(() => useUnassignedFaces('circle-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.hide(['face-1']);
    });

    expect(mockBulkHideFaces).toHaveBeenCalledWith('circle-1', ['face-1']);
  });

  it('returns the { hidden } result from the service', async () => {
    mockListUnassignedFaces.mockResolvedValue(makeUnassignedFacesResponse());
    mockBulkHideFaces.mockResolvedValue({ hidden: 3 });

    const { result } = renderHook(() => useUnassignedFaces('circle-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let hideResult: { hidden: number } | undefined;
    await act(async () => {
      hideResult = await result.current.hide(['f1', 'f2', 'f3']);
    });

    expect(hideResult).toEqual({ hidden: 3 });
  });

  it('does NOT auto-refresh after hide (unlike usePeople) — caller is responsible', async () => {
    mockListUnassignedFaces.mockResolvedValue(makeUnassignedFacesResponse());
    mockBulkHideFaces.mockResolvedValue({ hidden: 1 });

    const { result } = renderHook(() => useUnassignedFaces('circle-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.hide(['face-1']);
    });

    // Only the initial mount call — hide() itself does not trigger a refetch.
    expect(mockListUnassignedFaces).toHaveBeenCalledTimes(1);
  });

  it('resolves { hidden: 0 } without calling bulkHideFaces when circleId is null', async () => {
    const { result } = renderHook(() => useUnassignedFaces(null));

    let hideResult: { hidden: number } | undefined;
    await act(async () => {
      hideResult = await result.current.hide(['face-1']);
    });

    expect(mockBulkHideFaces).not.toHaveBeenCalled();
    expect(hideResult).toEqual({ hidden: 0 });
  });
});

// ---------------------------------------------------------------------------
// Tests: unhide()
// ---------------------------------------------------------------------------

describe('useUnassignedFaces — unhide()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls bulkUnhideFaces with circleId and ids', async () => {
    mockListUnassignedFaces.mockResolvedValue(makeUnassignedFacesResponse());
    mockBulkUnhideFaces.mockResolvedValue({ unhidden: 2 });

    const { result } = renderHook(() => useUnassignedFaces('circle-1', { archived: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.unhide(['face-a', 'face-b']);
    });

    expect(mockBulkUnhideFaces).toHaveBeenCalledWith('circle-1', ['face-a', 'face-b']);
  });

  it('returns the { unhidden } result from the service', async () => {
    mockListUnassignedFaces.mockResolvedValue(makeUnassignedFacesResponse());
    mockBulkUnhideFaces.mockResolvedValue({ unhidden: 2 });

    const { result } = renderHook(() => useUnassignedFaces('circle-1', { archived: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let unhideResult: { unhidden: number } | undefined;
    await act(async () => {
      unhideResult = await result.current.unhide(['face-a']);
    });

    expect(unhideResult).toEqual({ unhidden: 2 });
  });

  it('resolves { unhidden: 0 } without calling bulkUnhideFaces when circleId is null', async () => {
    const { result } = renderHook(() => useUnassignedFaces(null, { archived: true }));

    let unhideResult: { unhidden: number } | undefined;
    await act(async () => {
      unhideResult = await result.current.unhide(['face-a']);
    });

    expect(mockBulkUnhideFaces).not.toHaveBeenCalled();
    expect(unhideResult).toEqual({ unhidden: 0 });
  });
});

// ---------------------------------------------------------------------------
// Tests: purge()
// ---------------------------------------------------------------------------

describe('useUnassignedFaces — purge()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls purgeFaces with circleId and ids', async () => {
    mockListUnassignedFaces.mockResolvedValue(makeUnassignedFacesResponse());
    mockPurgeFaces.mockResolvedValue({ deleted: 1 });

    const { result } = renderHook(() => useUnassignedFaces('circle-1', { archived: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.purge(['face-a']);
    });

    expect(mockPurgeFaces).toHaveBeenCalledWith('circle-1', ['face-a']);
  });

  it('returns the { deleted } result from the service', async () => {
    mockListUnassignedFaces.mockResolvedValue(makeUnassignedFacesResponse());
    mockPurgeFaces.mockResolvedValue({ deleted: 5 });

    const { result } = renderHook(() => useUnassignedFaces('circle-1', { archived: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let purgeResult: { deleted: number } | undefined;
    await act(async () => {
      purgeResult = await result.current.purge(['f1', 'f2', 'f3', 'f4', 'f5']);
    });

    expect(purgeResult).toEqual({ deleted: 5 });
  });

  it('resolves { deleted: 0 } without calling purgeFaces when circleId is null', async () => {
    const { result } = renderHook(() => useUnassignedFaces(null, { archived: true }));

    let purgeResult: { deleted: number } | undefined;
    await act(async () => {
      purgeResult = await result.current.purge(['face-a']);
    });

    expect(mockPurgeFaces).not.toHaveBeenCalled();
    expect(purgeResult).toEqual({ deleted: 0 });
  });
});

// ---------------------------------------------------------------------------
// Tests: purgeArchived()
// ---------------------------------------------------------------------------

describe('useUnassignedFaces — purgeArchived()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls purgeArchivedFaces with circleId', async () => {
    mockListUnassignedFaces.mockResolvedValue(makeUnassignedFacesResponse());
    mockPurgeArchivedFaces.mockResolvedValue({ deleted: 12 });

    const { result } = renderHook(() => useUnassignedFaces('circle-1', { archived: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let purgeResult: { deleted: number } | undefined;
    await act(async () => {
      purgeResult = await result.current.purgeArchived();
    });

    expect(mockPurgeArchivedFaces).toHaveBeenCalledWith('circle-1');
    expect(purgeResult).toEqual({ deleted: 12 });
  });

  it('resolves { deleted: 0 } without calling purgeArchivedFaces when circleId is null', async () => {
    const { result } = renderHook(() => useUnassignedFaces(null, { archived: true }));

    let purgeResult: { deleted: number } | undefined;
    await act(async () => {
      purgeResult = await result.current.purgeArchived();
    });

    expect(mockPurgeArchivedFaces).not.toHaveBeenCalled();
    expect(purgeResult).toEqual({ deleted: 0 });
  });
});

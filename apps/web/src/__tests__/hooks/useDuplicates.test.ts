/**
 * Unit tests for useDuplicateGroups and useDuplicateGroupDetail hooks.
 *
 * Covers:
 *  useDuplicateGroups:
 *   - Initial state (empty items, null meta, not loading, no error)
 *   - fetchGroups: loading -> success (calls listDuplicateGroups with params, populates items/meta)
 *   - fetchGroups: error handling (Error instance and non-Error throw fallback message)
 *
 *  useDuplicateGroupDetail:
 *   - Initial state
 *   - fetchGroup: loading -> success (calls getDuplicateGroup with id, populates group)
 *   - fetchGroup: error handling
 *   - resolve: calls resolveDuplicateGroup with (groupId, keepIds, action); toggles `resolving`
 *   - resolve: error path — resolving resets to false and error propagates to caller
 *   - dismiss: calls dismissDuplicateGroup with groupId; toggles `dismissing`
 *   - dismiss: error path — dismissing resets to false and error propagates to caller
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useDuplicateGroups, useDuplicateGroupDetail } from '../../hooks/useDuplicates';

// ---------------------------------------------------------------------------
// Mock the duplicates service module
// ---------------------------------------------------------------------------

vi.mock('../../services/duplicates', () => ({
  listDuplicateGroups: vi.fn(),
  getDuplicateGroup: vi.fn(),
  resolveDuplicateGroup: vi.fn(),
  dismissDuplicateGroup: vi.fn(),
  // Needed by useDuplicateGroups' bulkResolve/bulkResolveByThreshold/
  // dismissByThreshold, which call these directly before replaying the last
  // fetchGroups() params (see the "replays the last fetch params" tests below).
  bulkResolveDuplicateGroups: vi.fn(),
  bulkResolveDuplicateGroupsByThreshold: vi.fn(),
  bulkDismissDuplicateGroupsByThreshold: vi.fn(),
  fetchAllPendingDuplicateGroupIds: vi.fn(),
}));

import {
  listDuplicateGroups,
  getDuplicateGroup,
  resolveDuplicateGroup,
  dismissDuplicateGroup,
  bulkResolveDuplicateGroups,
  bulkResolveDuplicateGroupsByThreshold,
  bulkDismissDuplicateGroupsByThreshold,
} from '../../services/duplicates';
import type {
  DuplicateGroupSummary,
  DuplicateGroupDetail,
  DuplicateListResponse,
} from '../../services/duplicates';

const mockListDuplicateGroups = vi.mocked(listDuplicateGroups);
const mockGetDuplicateGroup = vi.mocked(getDuplicateGroup);
const mockResolveDuplicateGroup = vi.mocked(resolveDuplicateGroup);
const mockDismissDuplicateGroup = vi.mocked(dismissDuplicateGroup);
const mockBulkResolveDuplicateGroups = vi.mocked(bulkResolveDuplicateGroups);
const mockBulkResolveDuplicateGroupsByThreshold = vi.mocked(bulkResolveDuplicateGroupsByThreshold);
const mockBulkDismissDuplicateGroupsByThreshold = vi.mocked(bulkDismissDuplicateGroupsByThreshold);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSummary(id = 'group-1'): DuplicateGroupSummary {
  return {
    id,
    status: 'pending',
    kind: 'exact_variant',
    mediaCount: 2,
    capturedAt: '2026-06-15T14:32:00.000Z',
    suggestedBestItemId: 'media-1',
    coverThumbnailUrls: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
  };
}

function makeListResponse(items: DuplicateGroupSummary[] = [makeSummary()]): DuplicateListResponse {
  return {
    items,
    meta: { total: items.length, page: 1, pageSize: 20 },
  };
}

function makeMember(id: string, isSuggestedBest = false) {
  return {
    id,
    thumbnailUrl: `https://cdn.example.com/${id}-thumb.jpg`,
    previewUrl: `https://cdn.example.com/${id}-preview.jpg`,
    width: 4032,
    height: 3024,
    fileSize: 2_500_000,
    capturedAt: '2026-06-15T14:32:00.000Z',
    cameraMake: 'Apple',
    cameraModel: 'iPhone 14',
    hasGps: true,
    contentHash: 'abc123',
    sharpnessScore: 210.5,
    qualityScore: isSuggestedBest ? 0.92 : 0.5,
    similarityToBest: isSuggestedBest ? null : 0.97,
    isSuggestedBest,
  };
}

function makeGroupDetail(id = 'group-test-id', suggestedBestItemId = 'media-1'): DuplicateGroupDetail {
  return {
    id,
    circleId: 'circle-1',
    status: 'pending',
    kind: 'exact_variant',
    mediaCount: 2,
    capturedAt: '2026-06-15T14:32:00.000Z',
    suggestedBestItemId,
    resolvedById: null,
    resolvedAt: null,
    members: [
      makeMember('media-1', suggestedBestItemId === 'media-1'),
      makeMember('media-2', suggestedBestItemId === 'media-2'),
    ],
  };
}

// ---------------------------------------------------------------------------
// useDuplicateGroups
// ---------------------------------------------------------------------------

describe('useDuplicateGroups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('starts with empty items, null meta, not loading, no error', () => {
      const { result } = renderHook(() => useDuplicateGroups());

      expect(result.current.items).toEqual([]);
      expect(result.current.meta).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('fetchGroups — success', () => {
    it('calls listDuplicateGroups with the given params', async () => {
      mockListDuplicateGroups.mockResolvedValue(makeListResponse());

      const { result } = renderHook(() => useDuplicateGroups());

      await act(async () => {
        await result.current.fetchGroups({ circleId: 'circle-1', status: 'pending', kind: 'edited', page: 2 });
      });

      expect(mockListDuplicateGroups).toHaveBeenCalledWith({
        circleId: 'circle-1',
        status: 'pending',
        kind: 'edited',
        page: 2,
      });
    });

    it('populates items and meta after a successful fetch', async () => {
      const response = makeListResponse([makeSummary('g-1'), makeSummary('g-2')]);
      mockListDuplicateGroups.mockResolvedValue(response);

      const { result } = renderHook(() => useDuplicateGroups());

      await act(async () => {
        await result.current.fetchGroups({ circleId: 'circle-1' });
      });

      expect(result.current.items).toEqual(response.items);
      expect(result.current.meta).toEqual(response.meta);
    });

    it('sets isLoading=true while fetching and false after resolution', async () => {
      let resolveFn!: (v: DuplicateListResponse) => void;
      const promise = new Promise<DuplicateListResponse>((res) => {
        resolveFn = res;
      });
      mockListDuplicateGroups.mockReturnValue(promise);

      const { result } = renderHook(() => useDuplicateGroups());

      let fetchPromise!: Promise<void>;
      act(() => {
        fetchPromise = result.current.fetchGroups({ circleId: 'circle-1' });
      });

      await waitFor(() => expect(result.current.isLoading).toBe(true));

      await act(async () => {
        resolveFn(makeListResponse());
        await fetchPromise;
      });

      expect(result.current.isLoading).toBe(false);
    });

    it('clears a previous error on a new successful fetch', async () => {
      mockListDuplicateGroups.mockRejectedValueOnce(new Error('boom'));
      const { result } = renderHook(() => useDuplicateGroups());

      await act(async () => {
        await result.current.fetchGroups({ circleId: 'circle-1' });
      });
      expect(result.current.error).toBe('boom');

      mockListDuplicateGroups.mockResolvedValueOnce(makeListResponse());
      await act(async () => {
        await result.current.fetchGroups({ circleId: 'circle-1' });
      });
      expect(result.current.error).toBeNull();
    });
  });

  describe('fetchGroups — error handling', () => {
    it('sets error message when listDuplicateGroups rejects with an Error', async () => {
      mockListDuplicateGroups.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useDuplicateGroups());

      await act(async () => {
        await result.current.fetchGroups({ circleId: 'circle-1' });
      });

      expect(result.current.error).toBe('Network error');
      expect(result.current.isLoading).toBe(false);
    });

    it('sets a fallback error message when a non-Error is thrown', async () => {
      mockListDuplicateGroups.mockRejectedValue('plain string');

      const { result } = renderHook(() => useDuplicateGroups());

      await act(async () => {
        await result.current.fetchGroups({ circleId: 'circle-1' });
      });

      expect(result.current.error).toBe('Failed to load duplicate groups');
    });

    it('leaves items empty when the fetch fails', async () => {
      mockListDuplicateGroups.mockRejectedValue(new Error('fail'));

      const { result } = renderHook(() => useDuplicateGroups());

      await act(async () => {
        await result.current.fetchGroups({ circleId: 'circle-1' });
      });

      expect(result.current.items).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Bulk operations replay the last fetch params, including sort (issue #189)
  // -------------------------------------------------------------------------

  describe('bulk operations replay the last fetchGroups params, including sort', () => {
    it('bulkResolve refetches with the sortBy/sortOrder from the last fetchGroups call', async () => {
      mockListDuplicateGroups.mockResolvedValue(makeListResponse());
      mockBulkResolveDuplicateGroups.mockResolvedValue({
        resolvedGroups: 1,
        keptCount: 1,
        removedCount: 1,
        action: 'archive',
        skipped: 0,
        errors: 0,
      });

      const { result } = renderHook(() => useDuplicateGroups());

      await act(async () => {
        await result.current.fetchGroups({
          circleId: 'circle-1',
          sortBy: 'confidence',
          sortOrder: 'desc',
        });
      });
      mockListDuplicateGroups.mockClear();

      await act(async () => {
        await result.current.bulkResolve(['group-1'], 'archive');
      });

      expect(mockBulkResolveDuplicateGroups).toHaveBeenCalledWith({
        circleId: 'circle-1',
        ids: ['group-1'],
        action: 'archive',
      });
      // The refresh after resolving must carry the same sort the user had
      // selected, not silently reset to the server default.
      expect(mockListDuplicateGroups).toHaveBeenCalledWith({
        circleId: 'circle-1',
        sortBy: 'confidence',
        sortOrder: 'desc',
      });
    });

    // Issue #190 replaced the synchronous, capped, auto-looped threshold
    // actions with a background run. The hook therefore no longer refetches
    // the list after starting one — there is nothing to show yet, and the
    // page navigates to /review-runs/:runId instead. These two tests
    // previously asserted the refetch (and the old resolve-tally response
    // shape); they now assert the run-start contract and the ABSENCE of a
    // refetch, which is the behaviour change itself.
    it('bulkResolveByThreshold starts a run and does not refetch the list', async () => {
      mockListDuplicateGroups.mockResolvedValue(makeListResponse());
      mockBulkResolveDuplicateGroupsByThreshold.mockResolvedValue({
        runId: 'run-1',
        status: 'evaluating',
        matchedCount: 0,
      });

      const { result } = renderHook(() => useDuplicateGroups());

      await act(async () => {
        await result.current.fetchGroups({
          circleId: 'circle-1',
          sortBy: 'mediaCount',
          sortOrder: 'asc',
        });
      });
      mockListDuplicateGroups.mockClear();

      let started: Awaited<ReturnType<typeof result.current.bulkResolveByThreshold>> | undefined;
      await act(async () => {
        started = await result.current.bulkResolveByThreshold(60, 'archive');
      });

      expect(mockBulkResolveDuplicateGroupsByThreshold).toHaveBeenCalledWith({
        circleId: 'circle-1',
        threshold: 60,
        action: 'archive',
      });
      expect(started).toEqual({ runId: 'run-1', status: 'evaluating', matchedCount: 0 });
      expect(mockListDuplicateGroups).not.toHaveBeenCalled();
    });

    it('dismissByThreshold starts a run and does not refetch the list', async () => {
      mockListDuplicateGroups.mockResolvedValue(makeListResponse());
      mockBulkDismissDuplicateGroupsByThreshold.mockResolvedValue({
        runId: 'run-2',
        status: 'evaluating',
        matchedCount: 0,
      });

      const { result } = renderHook(() => useDuplicateGroups());

      await act(async () => {
        await result.current.fetchGroups({
          circleId: 'circle-1',
          sortBy: 'confidence',
          sortOrder: 'asc',
        });
      });
      mockListDuplicateGroups.mockClear();

      let started: Awaited<ReturnType<typeof result.current.dismissByThreshold>> | undefined;
      await act(async () => {
        started = await result.current.dismissByThreshold(40);
      });

      expect(mockBulkDismissDuplicateGroupsByThreshold).toHaveBeenCalledWith({
        circleId: 'circle-1',
        threshold: 40,
      });
      expect(started).toEqual({ runId: 'run-2', status: 'evaluating', matchedCount: 0 });
      expect(mockListDuplicateGroups).not.toHaveBeenCalled();
    });

    it('refetches WITHOUT sortBy/sortOrder when the last fetchGroups call had no sort override (default view)', async () => {
      mockListDuplicateGroups.mockResolvedValue(makeListResponse());
      mockBulkResolveDuplicateGroups.mockResolvedValue({
        resolvedGroups: 1,
        keptCount: 1,
        removedCount: 1,
        action: 'archive',
        skipped: 0,
        errors: 0,
      });

      const { result } = renderHook(() => useDuplicateGroups());

      await act(async () => {
        await result.current.fetchGroups({ circleId: 'circle-1' });
      });
      mockListDuplicateGroups.mockClear();

      await act(async () => {
        await result.current.bulkResolve(['group-1'], 'archive');
      });

      expect(mockListDuplicateGroups).toHaveBeenCalledWith({ circleId: 'circle-1' });
    });
  });
});

// ---------------------------------------------------------------------------
// useDuplicateGroupDetail
// ---------------------------------------------------------------------------

describe('useDuplicateGroupDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('starts with null group, not loading, no error, resolving/dismissing false', () => {
      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      expect(result.current.group).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.resolving).toBe(false);
      expect(result.current.dismissing).toBe(false);
    });
  });

  describe('fetchGroup — success', () => {
    it('calls getDuplicateGroup with the given id', async () => {
      mockGetDuplicateGroup.mockResolvedValue(makeGroupDetail());

      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      await act(async () => {
        await result.current.fetchGroup('group-test-id');
      });

      expect(mockGetDuplicateGroup).toHaveBeenCalledWith('group-test-id');
    });

    it('populates group after a successful fetch', async () => {
      const detail = makeGroupDetail();
      mockGetDuplicateGroup.mockResolvedValue(detail);

      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      await act(async () => {
        await result.current.fetchGroup('group-test-id');
      });

      expect(result.current.group).toEqual(detail);
    });
  });

  describe('fetchGroup — error handling', () => {
    it('sets error message when getDuplicateGroup rejects with an Error', async () => {
      mockGetDuplicateGroup.mockRejectedValue(new Error('Group not found'));

      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      await act(async () => {
        await result.current.fetchGroup('group-test-id');
      });

      expect(result.current.error).toBe('Group not found');
      expect(result.current.group).toBeNull();
    });

    it('sets a fallback error message when a non-Error is thrown', async () => {
      mockGetDuplicateGroup.mockRejectedValue('plain string');

      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      await act(async () => {
        await result.current.fetchGroup('group-test-id');
      });

      expect(result.current.error).toBe('Failed to load duplicate group');
    });
  });

  describe('resolve', () => {
    it('calls resolveDuplicateGroup with (groupId, keepIds, action)', async () => {
      mockResolveDuplicateGroup.mockResolvedValue({
        removed: 1,
        kept: 1,
        action: 'archive',
        groupStatus: 'resolved',
      });

      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      await act(async () => {
        await result.current.resolve(['media-1'], 'archive');
      });

      expect(mockResolveDuplicateGroup).toHaveBeenCalledWith('group-test-id', ['media-1'], 'archive');
    });

    it('passes the action through unchanged for trash', async () => {
      mockResolveDuplicateGroup.mockResolvedValue({
        removed: 1,
        kept: 1,
        action: 'trash',
        groupStatus: 'resolved',
      });

      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      await act(async () => {
        await result.current.resolve(['media-1'], 'trash');
      });

      expect(mockResolveDuplicateGroup).toHaveBeenCalledWith('group-test-id', ['media-1'], 'trash');
    });

    it('returns the resolve result to the caller', async () => {
      const resolveResult = {
        removed: 1,
        kept: 1,
        action: 'archive' as const,
        groupStatus: 'resolved' as const,
      };
      mockResolveDuplicateGroup.mockResolvedValue(resolveResult);

      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      let returned: unknown;
      await act(async () => {
        returned = await result.current.resolve(['media-1'], 'archive');
      });

      expect(returned).toEqual(resolveResult);
    });

    it('sets resolving=true during the call and false after resolution', async () => {
      let resolveFn!: (v: {
        removed: number;
        kept: number;
        action: 'archive' | 'trash';
        groupStatus: 'pending' | 'resolved' | 'dismissed';
      }) => void;
      const promise = new Promise<{
        removed: number;
        kept: number;
        action: 'archive' | 'trash';
        groupStatus: 'pending' | 'resolved' | 'dismissed';
      }>((res) => {
        resolveFn = res;
      });
      mockResolveDuplicateGroup.mockReturnValue(promise);

      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      let callPromise!: Promise<unknown>;
      act(() => {
        callPromise = result.current.resolve(['media-1'], 'archive');
      });

      await waitFor(() => expect(result.current.resolving).toBe(true));

      await act(async () => {
        resolveFn({ removed: 1, kept: 1, action: 'archive', groupStatus: 'resolved' });
        await callPromise;
      });

      expect(result.current.resolving).toBe(false);
    });

    it('resets resolving=false and rethrows when resolveDuplicateGroup rejects', async () => {
      mockResolveDuplicateGroup.mockRejectedValue(new Error('Resolve failed'));

      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      await act(async () => {
        await expect(result.current.resolve(['media-1'], 'archive')).rejects.toThrow('Resolve failed');
      });

      expect(result.current.resolving).toBe(false);
    });
  });

  describe('dismiss', () => {
    it('calls dismissDuplicateGroup with the groupId', async () => {
      mockDismissDuplicateGroup.mockResolvedValue({ groupStatus: 'dismissed', ungrouped: 2 });

      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      await act(async () => {
        await result.current.dismiss();
      });

      expect(mockDismissDuplicateGroup).toHaveBeenCalledWith('group-test-id');
    });

    it('returns the dismiss result to the caller', async () => {
      const dismissResult = { groupStatus: 'dismissed' as const, ungrouped: 2 };
      mockDismissDuplicateGroup.mockResolvedValue(dismissResult);

      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      let returned: unknown;
      await act(async () => {
        returned = await result.current.dismiss();
      });

      expect(returned).toEqual(dismissResult);
    });

    it('sets dismissing=true during the call and false after resolution', async () => {
      let resolveFn!: (v: { groupStatus: 'pending' | 'resolved' | 'dismissed'; ungrouped: number }) => void;
      const promise = new Promise<{ groupStatus: 'pending' | 'resolved' | 'dismissed'; ungrouped: number }>(
        (res) => {
          resolveFn = res;
        },
      );
      mockDismissDuplicateGroup.mockReturnValue(promise);

      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      let callPromise!: Promise<unknown>;
      act(() => {
        callPromise = result.current.dismiss();
      });

      await waitFor(() => expect(result.current.dismissing).toBe(true));

      await act(async () => {
        resolveFn({ groupStatus: 'dismissed', ungrouped: 2 });
        await callPromise;
      });

      expect(result.current.dismissing).toBe(false);
    });

    it('resets dismissing=false and rethrows when dismissDuplicateGroup rejects', async () => {
      mockDismissDuplicateGroup.mockRejectedValue(new Error('Dismiss failed'));

      const { result } = renderHook(() => useDuplicateGroupDetail('group-test-id'));

      await act(async () => {
        await expect(result.current.dismiss()).rejects.toThrow('Dismiss failed');
      });

      expect(result.current.dismissing).toBe(false);
    });
  });
});

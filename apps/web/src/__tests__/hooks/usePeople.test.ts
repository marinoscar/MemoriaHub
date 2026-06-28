/**
 * Unit tests for usePeople and usePerson hooks.
 *
 * Mirrors the pattern of useMediaFaces.test.ts and useAiSettings.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock the face service module
// ---------------------------------------------------------------------------

vi.mock('../../services/face', () => ({
  listPeople: vi.fn(),
  getPerson: vi.fn(),
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
  assignFaces: vi.fn(),
  unassignFace: vi.fn(),
  clusterUnknownFaces: vi.fn(),
}));

import {
  listPeople,
  getPerson,
  createPerson,
  updatePerson,
  assignFaces,
  unassignFace,
  clusterUnknownFaces,
} from '../../services/face';
import type { PersonListResponse, PersonDetail, ClusterResult } from '../../services/face';
import { usePeople, usePerson } from '../../hooks/usePeople';

const mockListPeople = vi.mocked(listPeople);
const mockGetPerson = vi.mocked(getPerson);
const mockCreatePerson = vi.mocked(createPerson);
const mockUpdatePerson = vi.mocked(updatePerson);
const mockAssignFaces = vi.mocked(assignFaces);
const mockUnassignFace = vi.mocked(unassignFace);
const mockClusterUnknownFaces = vi.mocked(clusterUnknownFaces);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePersonListResponse(overrides: Partial<PersonListResponse> = {}): PersonListResponse {
  return {
    items: [
      {
        id: 'person-1',
        name: 'Alice',
        isUnlabeled: false,
        faceCount: 3,
        coverFace: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    meta: {
      page: 1,
      pageSize: 100,
      totalItems: 1,
      totalPages: 1,
    },
    ...overrides,
  };
}

function makePersonDetail(): PersonDetail {
  return {
    id: 'person-1',
    name: 'Alice',
    isUnlabeled: false,
    circleId: 'circle-1',
    coverFace: null,
    faces: [
      {
        faceId: 'face-1',
        mediaItemId: 'media-1',
        boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        confidence: 0.9,
        manuallyAssigned: false,
        createdAt: new Date().toISOString(),
        faceThumbnailUrl: null,
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const makeClusterResult = (): ClusterResult => ({
  clustersCreated: 2,
  facesAssigned: 5,
});

// ---------------------------------------------------------------------------
// Tests: usePeople
// ---------------------------------------------------------------------------

describe('usePeople', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  describe('initial load', () => {
    it('calls listPeople on mount with circleId', async () => {
      mockListPeople.mockResolvedValue(makePersonListResponse());

      renderHook(() => usePeople('circle-1'));

      await waitFor(() => {
        expect(mockListPeople).toHaveBeenCalledWith('circle-1', expect.objectContaining({ pageSize: 100 }));
      });
    });

    it('populates data after successful load', async () => {
      const response = makePersonListResponse();
      mockListPeople.mockResolvedValue(response);

      const { result } = renderHook(() => usePeople('circle-1'));

      await waitFor(() => {
        expect(result.current.data).toEqual(response);
      });
    });

    it('starts with data null and loading false', () => {
      mockListPeople.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => usePeople('circle-1'));

      expect(result.current.data).toBeNull();
      expect(result.current.error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('loading state', () => {
    it('sets loading=true while fetching and false after', async () => {
      let resolveList!: (v: PersonListResponse) => void;
      const deferred = new Promise<PersonListResponse>((res) => { resolveList = res; });
      mockListPeople.mockReturnValue(deferred);

      const { result } = renderHook(() => usePeople('circle-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(true);
      });

      await act(async () => {
        resolveList(makePersonListResponse());
        await deferred;
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('sets error message when listPeople rejects with Error', async () => {
      mockListPeople.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => usePeople('circle-1'));

      await waitFor(() => {
        expect(result.current.error).toBe('Network error');
      });
    });

    it('sets fallback error when listPeople rejects with non-Error', async () => {
      mockListPeople.mockRejectedValue('plain string error');

      const { result } = renderHook(() => usePeople('circle-1'));

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to load people');
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('create()', () => {
    it('calls createPerson then refresh', async () => {
      mockListPeople.mockResolvedValue(makePersonListResponse());
      mockCreatePerson.mockResolvedValue({ id: 'new-person', name: 'Bob', circleId: 'circle-1' });

      const { result } = renderHook(() => usePeople('circle-1'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.create({ name: 'Bob' });
      });

      expect(mockCreatePerson).toHaveBeenCalledWith({ circleId: 'circle-1', name: 'Bob' });
      // listPeople called twice: once on mount, once after create
      expect(mockListPeople).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('rename()', () => {
    it('calls updatePerson then refresh', async () => {
      mockListPeople.mockResolvedValue(makePersonListResponse());
      mockUpdatePerson.mockResolvedValue({
        id: 'person-1',
        name: 'Alice Updated',
        coverFaceId: null,
        updatedAt: new Date().toISOString(),
      });

      const { result } = renderHook(() => usePeople('circle-1'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.rename('person-1', 'Alice Updated');
      });

      expect(mockUpdatePerson).toHaveBeenCalledWith('person-1', { name: 'Alice Updated' });
      expect(mockListPeople).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('cluster()', () => {
    it('calls clusterUnknownFaces then refresh, returns ClusterResult', async () => {
      mockListPeople.mockResolvedValue(makePersonListResponse());
      mockClusterUnknownFaces.mockResolvedValue(makeClusterResult());

      const { result } = renderHook(() => usePeople('circle-1'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let clusterResult!: ClusterResult;
      await act(async () => {
        clusterResult = await result.current.cluster();
      });

      expect(mockClusterUnknownFaces).toHaveBeenCalledWith('circle-1');
      expect(clusterResult).toEqual(makeClusterResult());
      expect(mockListPeople).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('assignFaces()', () => {
    it('calls assignFaces service then refresh', async () => {
      mockListPeople.mockResolvedValue(makePersonListResponse());
      mockAssignFaces.mockResolvedValue({ personId: 'person-1', assignedCount: 2 });

      const { result } = renderHook(() => usePeople('circle-1'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.assignFaces('person-1', ['face-a', 'face-b']);
      });

      expect(mockAssignFaces).toHaveBeenCalledWith('person-1', ['face-a', 'face-b']);
      expect(mockListPeople).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('unassignFace()', () => {
    it('calls unassignFace service then refresh', async () => {
      mockListPeople.mockResolvedValue(makePersonListResponse());
      mockUnassignFace.mockResolvedValue(undefined);

      const { result } = renderHook(() => usePeople('circle-1'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.unassignFace('person-1', 'face-1');
      });

      expect(mockUnassignFace).toHaveBeenCalledWith('person-1', 'face-1');
      expect(mockListPeople).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('null circleId', () => {
    it('does not call listPeople when circleId is null', () => {
      mockListPeople.mockResolvedValue(makePersonListResponse());

      renderHook(() => usePeople(null));

      expect(mockListPeople).not.toHaveBeenCalled();
    });

    it('refresh is a no-op when circleId is null', async () => {
      const { result } = renderHook(() => usePeople(null));

      await act(async () => {
        await result.current.refresh();
      });

      expect(mockListPeople).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: usePerson
// ---------------------------------------------------------------------------

describe('usePerson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  describe('initial load', () => {
    it('calls getPerson on mount', async () => {
      mockGetPerson.mockResolvedValue(makePersonDetail());

      renderHook(() => usePerson('person-1'));

      await waitFor(() => {
        expect(mockGetPerson).toHaveBeenCalledWith('person-1');
      });
    });

    it('populates person after load', async () => {
      const detail = makePersonDetail();
      mockGetPerson.mockResolvedValue(detail);

      const { result } = renderHook(() => usePerson('person-1'));

      await waitFor(() => {
        expect(result.current.person).toEqual(detail);
      });
    });

    it('starts with person null', () => {
      mockGetPerson.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => usePerson('person-1'));

      expect(result.current.person).toBeNull();
      expect(result.current.error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('loading state', () => {
    it('sets loading=true during fetch', async () => {
      mockGetPerson.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => usePerson('person-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('sets error message when getPerson rejects', async () => {
      mockGetPerson.mockRejectedValue(new Error('Person not found'));

      const { result } = renderHook(() => usePerson('person-1'));

      await waitFor(() => {
        expect(result.current.error).toBe('Person not found');
      });
    });

    it('sets fallback error for non-Error throws', async () => {
      mockGetPerson.mockRejectedValue('unexpected');

      const { result } = renderHook(() => usePerson('person-1'));

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to load person');
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('null personId', () => {
    it('does not call getPerson when personId is null', () => {
      mockGetPerson.mockResolvedValue(makePersonDetail());

      renderHook(() => usePerson(null));

      expect(mockGetPerson).not.toHaveBeenCalled();
    });

    it('refresh is a no-op when personId is null', async () => {
      const { result } = renderHook(() => usePerson(null));

      await act(async () => {
        await result.current.refresh();
      });

      expect(mockGetPerson).not.toHaveBeenCalled();
    });
  });
});

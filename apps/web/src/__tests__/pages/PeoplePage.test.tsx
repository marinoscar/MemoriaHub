/**
 * Unit tests for PeoplePage.
 *
 * Mocking strategy:
 *   - usePeople and usePerson hooks are module-mocked.
 *   - CircleContext is provided via the test-utils render wrapper.
 *   - services/media and services/face are mocked to avoid real API calls
 *     from PersonCardContainer and PersonDetailDrawer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — must be BEFORE imports that consume them
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePeople', () => ({
  usePeople: vi.fn(),
  usePerson: vi.fn(),
}));

vi.mock('../../services/media', () => ({
  listMedia: vi.fn().mockResolvedValue({ items: [], meta: {} }),
}));

vi.mock('../../services/face', () => ({
  listPeople: vi.fn(),
  getPerson: vi.fn(),
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
  assignFaces: vi.fn(),
  unassignFace: vi.fn(),
  clusterUnknownFaces: vi.fn(),
  getCircleFaceSettings: vi.fn().mockResolvedValue({ faceRecognitionEnabled: true }),
  updateCircleFaceSettings: vi.fn().mockResolvedValue({ faceRecognitionEnabled: true }),
  deleteCircleBiometrics: vi.fn().mockResolvedValue({ deletedFaces: 0, deletedPeople: 0 }),
  mergePeople: vi.fn().mockResolvedValue({}),
  deletePerson: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import PeoplePage from '../../pages/People/PeoplePage';
import { usePeople, usePerson } from '../../hooks/usePeople';

const mockUsePeople = vi.mocked(usePeople);
const mockUsePerson = vi.mocked(usePerson);

// ---------------------------------------------------------------------------
// Default mock return values
// ---------------------------------------------------------------------------

import type { PersonListItem, PersonDetail } from '../../services/face';

function makePerson(id: string, name: string | null = 'Alice', isUnlabeled = false): PersonListItem {
  return {
    id,
    name,
    isUnlabeled,
    faceCount: 2,
    coverFace: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makePersonDetail(id: string = 'person-1'): PersonDetail {
  return {
    id,
    name: 'Alice',
    isUnlabeled: false,
    circleId: 'circle-1',
    coverFace: null,
    faces: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeUsePeopleDefaults(items: PersonListItem[] = [], overrides: Record<string, unknown> = {}) {
  return {
    data: { items, meta: { page: 1, pageSize: 100, totalItems: items.length, totalPages: 1 } },
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    cluster: vi.fn().mockResolvedValue({ clustersCreated: 0, facesAssigned: 0 }),
    assignFaces: vi.fn().mockResolvedValue(undefined),
    unassignFace: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeUsePersonDefaults(person: PersonDetail | null = null): any {
  return {
    person,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PeoplePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: usePeople returns empty lists, usePerson returns null
    mockUsePeople.mockReturnValue(makeUsePeopleDefaults() as any);
    mockUsePerson.mockReturnValue(makeUsePersonDefaults() as any);
  });

  // -------------------------------------------------------------------------
  describe('no active circle', () => {
    it('shows "Select a circle" alert when no activeCircleId', () => {
      render(<PeoplePage />, {
        wrapperOptions: { activeCircle: null, activeCircleRole: null },
      });

      expect(screen.getByText(/select a circle to view people/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('with active circle', () => {
    it('renders "Named People" section heading', () => {
      render(<PeoplePage />);

      // Use heading role to uniquely identify the h6 heading (not the empty-state text)
      expect(screen.getByRole('heading', { name: /named people/i })).toBeInTheDocument();
    });

    it('renders "Unknown People" section from UnknownFacesReview', () => {
      render(<PeoplePage />);

      // The "Unknown People" h6 heading rendered by UnknownFacesReview
      expect(screen.getByRole('heading', { name: /unknown people/i })).toBeInTheDocument();
    });

    it('renders labeled people names', () => {
      mockUsePeople
        .mockReturnValueOnce(
          makeUsePeopleDefaults([makePerson('p1', 'Alice'), makePerson('p2', 'Bob')]) as any,
        )
        .mockReturnValueOnce(makeUsePeopleDefaults([]) as any);

      render(<PeoplePage />);

      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    it('opens drawer when a labeled person card is clicked', async () => {
      mockUsePeople
        .mockReturnValueOnce(makeUsePeopleDefaults([makePerson('p1', 'Alice')]) as any)
        .mockReturnValueOnce(makeUsePeopleDefaults([]) as any);

      // usePerson is called when drawer opens
      mockUsePerson.mockReturnValue(makeUsePersonDefaults(makePersonDetail('p1')) as any);

      const user = userEvent.setup();

      render(<PeoplePage />);

      await user.click(screen.getByText('Alice'));

      // The drawer renders PersonDetailDrawer which shows the person name
      await waitFor(() => {
        // usePerson will have been called now
        expect(mockUsePerson).toHaveBeenCalledWith('p1');
      });
    });

    it('shows "Find People" button when user has collaborator role', () => {
      render(<PeoplePage />, {
        wrapperOptions: { activeCircleRole: 'collaborator' },
      });

      expect(screen.getByRole('button', { name: /find people/i })).toBeInTheDocument();
    });

    it('hides "Find People" button when user has viewer role', () => {
      render(<PeoplePage />, {
        wrapperOptions: { activeCircleRole: 'viewer' },
      });

      expect(screen.queryByRole('button', { name: /find people/i })).not.toBeInTheDocument();
    });
  });
});

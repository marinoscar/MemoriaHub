/**
 * Unit tests for PeoplePage.
 *
 * Mocking strategy:
 *   - usePeople and usePerson hooks are module-mocked.
 *   - CircleContext is provided via the test-utils render wrapper.
 *   - services/media and services/face are mocked to avoid real API calls
 *     from PersonCardContainer and PersonDetailDrawer.
 *
 * Note: The per-circle face recognition opt-in gate was removed in the
 * settings refactor. PeoplePage now always renders the people view directly;
 * face recognition is controlled globally from admin settings.
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
  deleteCircleBiometrics: vi.fn().mockResolvedValue({ deletedFaces: 0, deletedPeople: 0 }),
  mergePeople: vi.fn().mockResolvedValue({}),
  deletePerson: vi.fn().mockResolvedValue(undefined),
  setPersonFavorite: vi.fn().mockResolvedValue(undefined),
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
import * as faceService from '../../services/face';

const mockUsePeople = vi.mocked(usePeople);
const mockUsePerson = vi.mocked(usePerson);
const mockDeleteCircleBiometrics = vi.mocked(faceService.deleteCircleBiometrics);

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
    it('renders "Named People" section heading', async () => {
      render(<PeoplePage />);

      expect(await screen.findByRole('heading', { name: /named people/i })).toBeInTheDocument();
    });

    it('renders "Unknown People" section from UnknownFacesReview', async () => {
      render(<PeoplePage />);

      // The "Unknown People" h6 heading rendered by UnknownFacesReview
      expect(await screen.findByRole('heading', { name: /unknown people/i })).toBeInTheDocument();
    });

    it('renders labeled people names', async () => {
      mockUsePeople.mockImplementation((_, opts?: { includeUnlabeled?: boolean }) => {
        if (opts?.includeUnlabeled) return makeUsePeopleDefaults([]) as any;
        return makeUsePeopleDefaults([makePerson('p1', 'Alice'), makePerson('p2', 'Bob')]) as any;
      });

      render(<PeoplePage />);

      expect(await screen.findByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    it('opens drawer when a labeled person card is clicked', async () => {
      mockUsePeople.mockImplementation((_, opts?: { includeUnlabeled?: boolean }) => {
        if (opts?.includeUnlabeled) return makeUsePeopleDefaults([]) as any;
        return makeUsePeopleDefaults([makePerson('p1', 'Alice')]) as any;
      });

      // usePerson is called when drawer opens
      mockUsePerson.mockReturnValue(makeUsePersonDefaults(makePersonDetail('p1')) as any);

      const user = userEvent.setup();

      render(<PeoplePage />);

      await screen.findByText('Alice');
      await user.click(screen.getByText('Alice'));

      // The drawer renders PersonDetailDrawer which shows the person name
      await waitFor(() => {
        // usePerson will have been called now
        expect(mockUsePerson).toHaveBeenCalledWith('p1');
      });
    });

    it('shows "Find People" button when user has collaborator role', async () => {
      render(<PeoplePage />, {
        wrapperOptions: { activeCircleRole: 'collaborator' },
      });

      expect(await screen.findByRole('button', { name: /find people/i })).toBeInTheDocument();
    });

    it('hides "Find People" button when user has viewer role', async () => {
      render(<PeoplePage />, {
        wrapperOptions: { activeCircleRole: 'viewer' },
      });

      // Wait for progressbar to disappear
      await waitFor(() => {
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /find people/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('settings menu (circle_admin)', () => {
    it('shows the settings (gear) icon button for circle_admin', async () => {
      render(<PeoplePage />, { wrapperOptions: { activeCircleRole: 'circle_admin' } });
      expect(await screen.findByRole('button', { name: /face recognition settings/i })).toBeInTheDocument();
    });

    it('does NOT show the settings icon for viewer role', async () => {
      render(<PeoplePage />, { wrapperOptions: { activeCircleRole: 'viewer' } });
      await screen.findByRole('heading', { name: /named people/i });
      expect(screen.queryByRole('button', { name: /face recognition settings/i })).not.toBeInTheDocument();
    });

    it('opens menu with "Delete all biometrics" item', async () => {
      const user = userEvent.setup();
      render(<PeoplePage />, { wrapperOptions: { activeCircleRole: 'circle_admin' } });
      const gearBtn = await screen.findByRole('button', { name: /face recognition settings/i });
      await user.click(gearBtn);
      expect(screen.getByText(/delete all biometrics/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('delete-biometrics dialog', () => {
    async function openDeleteBiometricsDialog(user: ReturnType<typeof userEvent.setup>) {
      const gearBtn = await screen.findByRole('button', { name: /face recognition settings/i });
      await user.click(gearBtn);
      const deleteItem = await screen.findByText(/delete all biometrics/i);
      await user.click(deleteItem);
    }

    it('opens the "Delete All Biometric Data" dialog when menu item clicked', async () => {
      const user = userEvent.setup();
      render(<PeoplePage />, { wrapperOptions: { activeCircleRole: 'circle_admin' } });
      await openDeleteBiometricsDialog(user);
      expect(await screen.findByRole('heading', { name: /delete all biometric data/i })).toBeInTheDocument();
    });

    it('Delete button is disabled until "DELETE" is typed', async () => {
      const user = userEvent.setup();
      render(<PeoplePage />, { wrapperOptions: { activeCircleRole: 'circle_admin' } });
      await openDeleteBiometricsDialog(user);
      const deleteBtn = await screen.findByRole('button', { name: /delete all biometric data/i });
      expect(deleteBtn).toBeDisabled();
    });

    it('Delete button becomes enabled after typing "DELETE"', async () => {
      const user = userEvent.setup();
      render(<PeoplePage />, { wrapperOptions: { activeCircleRole: 'circle_admin' } });
      await openDeleteBiometricsDialog(user);
      const input = await screen.findByPlaceholderText(/DELETE/);
      await user.type(input, 'DELETE');
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /delete all biometric data/i })).not.toBeDisabled();
      });
    });

    it('calls deleteCircleBiometrics when DELETE typed and button clicked', async () => {
      mockDeleteCircleBiometrics.mockResolvedValue({ deletedFaces: 10, deletedPeople: 3 });
      const user = userEvent.setup();
      render(<PeoplePage />, { wrapperOptions: { activeCircleRole: 'circle_admin' } });
      await openDeleteBiometricsDialog(user);
      const input = await screen.findByPlaceholderText(/DELETE/);
      await user.type(input, 'DELETE');
      const deleteBtn = screen.getByRole('button', { name: /delete all biometric data/i });
      await user.click(deleteBtn);
      await waitFor(() => {
        expect(mockDeleteCircleBiometrics).toHaveBeenCalledWith('circle-1');
      });
    });
  });
});

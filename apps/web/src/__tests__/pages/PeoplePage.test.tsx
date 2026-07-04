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
import { screen, waitFor, within } from '@testing-library/react';
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
  // Used by UnassignedFacesSection's FaceThumbGrid to resolve fallback
  // thumbnails when a face has no faceThumbnailUrl of its own.
  getMedia: vi.fn().mockResolvedValue({
    id: 'media-1',
    thumbnailUrl: 'https://example.com/thumb.jpg',
    downloadUrl: null,
  }),
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
  bulkHidePeople: vi.fn().mockResolvedValue({ hidden: 0 }),
  bulkUnhidePeople: vi.fn().mockResolvedValue({ unhidden: 0 }),
  purgePeople: vi.fn().mockResolvedValue({ deleted: 0 }),
  // useUnassignedFaces (used by UnassignedFacesSection) is NOT mocked as a
  // hook — it's the real implementation — so its underlying service calls
  // must be stubbed here. Default: no live or archived faces, so the section
  // renders nothing (matches pre-existing test expectations elsewhere in
  // this file that don't care about unassigned faces).
  listUnassignedFaces: vi.fn().mockResolvedValue({
    items: [],
    meta: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 },
  }),
  bulkHideFaces: vi.fn().mockResolvedValue({ hidden: 0 }),
  bulkUnhideFaces: vi.fn().mockResolvedValue({ unhidden: 0 }),
  purgeFaces: vi.fn().mockResolvedValue({ deleted: 0 }),
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
const mockListUnassignedFaces = vi.mocked(faceService.listUnassignedFaces);
const mockBulkHideFaces = vi.mocked(faceService.bulkHideFaces);
const mockBulkUnhideFaces = vi.mocked(faceService.bulkUnhideFaces);
const mockPurgeFaces = vi.mocked(faceService.purgeFaces);

// ---------------------------------------------------------------------------
// Default mock return values
// ---------------------------------------------------------------------------

import type { PersonListItem, PersonDetail, UnassignedFaceDto } from '../../services/face';

function makeUnassignedFace(overrides: Partial<UnassignedFaceDto> = {}): UnassignedFaceDto {
  return {
    faceId: 'face-1',
    mediaItemId: 'media-1',
    boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    faceThumbnailUrl: 'https://example.com/face-1.jpg',
    hiddenAt: null,
    ...overrides,
  };
}

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
    hide: vi.fn().mockResolvedValue({ hidden: 0 }),
    unhide: vi.fn().mockResolvedValue({ unhidden: 0 }),
    purge: vi.fn().mockResolvedValue({ deleted: 0 }),
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

  // -------------------------------------------------------------------------
  describe('tabs — People / Hidden', () => {
    it('renders "People" and "Hidden" tabs', async () => {
      render(<PeoplePage />);

      expect(await screen.findByRole('tab', { name: /^people$/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /hidden/i })).toBeInTheDocument();
    });

    it('shows the People tab content by default (Named People heading)', async () => {
      render(<PeoplePage />);

      expect(await screen.findByRole('heading', { name: /named people/i })).toBeInTheDocument();
    });

    it('switches to the Hidden tab when clicked', async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await screen.findByRole('tab', { name: /^people$/i });
      await user.click(screen.getByRole('tab', { name: /hidden/i }));

      // HiddenPeopleView renders an empty state message when no hidden people
      await waitFor(() => {
        expect(screen.getByText(/no hidden people/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('hide button on PersonCard', () => {
    it('shows the hide button on labeled person cards (onHide prop passed)', async () => {
      mockUsePeople.mockImplementation((_, opts?: { includeUnlabeled?: boolean; hidden?: boolean }) => {
        if (opts?.hidden) return makeUsePeopleDefaults([]) as any;
        if (opts?.includeUnlabeled) return makeUsePeopleDefaults([]) as any;
        return makeUsePeopleDefaults([makePerson('p1', 'Alice')]) as any;
      });

      render(<PeoplePage />);

      await screen.findByText('Alice');
      expect(screen.getByRole('button', { name: /hide person/i })).toBeInTheDocument();
    });

    it('calls hide() when hide button is clicked on a person card', async () => {
      const hideFn = vi.fn().mockResolvedValue({ hidden: 1 });
      mockUsePeople.mockImplementation((_, opts?: { includeUnlabeled?: boolean; hidden?: boolean }) => {
        if (opts?.hidden) return makeUsePeopleDefaults([]) as any;
        if (opts?.includeUnlabeled) return makeUsePeopleDefaults([]) as any;
        return makeUsePeopleDefaults([makePerson('p1', 'Alice')], { hide: hideFn }) as any;
      });

      const user = userEvent.setup();
      render(<PeoplePage />);

      await screen.findByText('Alice');
      await user.click(screen.getByRole('button', { name: /hide person/i }));

      await waitFor(() => {
        expect(hideFn).toHaveBeenCalledWith(['p1']);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Hidden tab — unhide button', () => {
    it('shows the unhide button on hidden person cards', async () => {
      const hiddenPerson = makePerson('hp1', 'Bob');
      mockUsePeople.mockImplementation((_, opts?: { includeUnlabeled?: boolean; hidden?: boolean }) => {
        if (opts?.hidden) return makeUsePeopleDefaults([hiddenPerson]) as any;
        return makeUsePeopleDefaults([]) as any;
      });

      const user = userEvent.setup();
      render(<PeoplePage />);

      await screen.findByRole('tab', { name: /hidden/i });
      await user.click(screen.getByRole('tab', { name: /hidden/i }));

      await waitFor(() => {
        expect(screen.getByText('Bob')).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /unhide person/i })).toBeInTheDocument();
    });

    it('calls unhide() when the unhide button is clicked', async () => {
      const hiddenPerson = makePerson('hp1', 'Bob');
      const unhideFn = vi.fn().mockResolvedValue({ unhidden: 1 });
      mockUsePeople.mockImplementation((_, opts?: { includeUnlabeled?: boolean; hidden?: boolean }) => {
        if (opts?.hidden) return makeUsePeopleDefaults([hiddenPerson], { unhide: unhideFn }) as any;
        return makeUsePeopleDefaults([]) as any;
      });

      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(screen.getByRole('tab', { name: /hidden/i }));
      await screen.findByRole('button', { name: /unhide person/i });
      await user.click(screen.getByRole('button', { name: /unhide person/i }));

      await waitFor(() => {
        expect(unhideFn).toHaveBeenCalledWith(['hp1']);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('PurgePeopleDialog', () => {
    it('opens the purge dialog when "Delete permanently" button is clicked in hidden tab bulk toolbar', async () => {
      const hiddenPerson = makePerson('hp1', 'Bob');
      const unhideFn = vi.fn().mockResolvedValue({ unhidden: 0 });
      const purgeFn = vi.fn().mockResolvedValue({ deleted: 1 });

      mockUsePeople.mockImplementation((_, opts?: { includeUnlabeled?: boolean; hidden?: boolean }) => {
        if (opts?.hidden) {
          return makeUsePeopleDefaults([hiddenPerson], { unhide: unhideFn, purge: purgeFn }) as any;
        }
        return makeUsePeopleDefaults([]) as any;
      });

      const user = userEvent.setup();
      render(<PeoplePage />);

      // Switch to Hidden tab
      await user.click(screen.getByRole('tab', { name: /hidden/i }));
      await screen.findByText('Bob');

      // Click on the card to enter selection mode
      await user.click(screen.getByText('Bob'));

      // Now "Delete permanently" bulk action should appear
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /delete permanently/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /delete permanently/i }));

      // PurgePeopleDialog should open
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /delete permanently/i })).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('UnassignedFacesSection — archive / restore / delete individual faces', () => {
    it('archiving selected faces calls bulkHideFaces and refreshes the unassigned lists', async () => {
      const liveFace = makeUnassignedFace({ faceId: 'face-1' });
      mockListUnassignedFaces.mockImplementation(async (_circleId, opts) => {
        if (opts?.archived) {
          return { items: [], meta: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 } };
        }
        return { items: [liveFace], meta: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 } };
      });
      mockBulkHideFaces.mockResolvedValue({ hidden: 1 });

      const user = userEvent.setup();
      render(<PeoplePage />);

      await screen.findByText(/unassigned faces \(1\)/i);

      // Select the single live face via its checkbox
      const checkbox = screen.getByRole('checkbox');
      await user.click(checkbox);

      const archiveBtn = await screen.findByRole('button', { name: /^archive$/i });
      await user.click(archiveBtn);

      await waitFor(() => {
        expect(mockBulkHideFaces).toHaveBeenCalledWith('circle-1', ['face-1']);
      });

      // Both the live and archived unassigned-face lists are refreshed after archiving:
      // 2 initial mount calls (live + archived) + 2 refresh calls = 4.
      await waitFor(() => {
        expect(mockListUnassignedFaces.mock.calls.length).toBeGreaterThanOrEqual(4);
      });
    });

    it('the archived faces sub-view fetches with archived:true and renders archived faces', async () => {
      const archivedFace = makeUnassignedFace({ faceId: 'face-a', mediaItemId: 'media-a' });
      mockListUnassignedFaces.mockImplementation(async (_circleId, opts) => {
        if (opts?.archived) {
          return { items: [archivedFace], meta: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 } };
        }
        return { items: [], meta: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 } };
      });

      const user = userEvent.setup();
      render(<PeoplePage />);

      const showBtn = await screen.findByRole('button', { name: /show archived faces/i });
      await user.click(showBtn);

      // The archived face grid renders with a selectable checkbox once expanded
      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeInTheDocument();
      });

      expect(mockListUnassignedFaces).toHaveBeenCalledWith(
        'circle-1',
        expect.objectContaining({ archived: true }),
      );
    });

    it('restore calls bulkUnhideFaces with the selected archived face ids', async () => {
      const archivedFace = makeUnassignedFace({ faceId: 'face-a', mediaItemId: 'media-a' });
      mockListUnassignedFaces.mockImplementation(async (_circleId, opts) => {
        if (opts?.archived) {
          return { items: [archivedFace], meta: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 } };
        }
        return { items: [], meta: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 } };
      });
      mockBulkUnhideFaces.mockResolvedValue({ unhidden: 1 });

      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(await screen.findByRole('button', { name: /show archived faces/i }));
      const checkbox = await screen.findByRole('checkbox');
      await user.click(checkbox);

      const restoreBtn = await screen.findByRole('button', { name: /^restore$/i });
      await user.click(restoreBtn);

      await waitFor(() => {
        expect(mockBulkUnhideFaces).toHaveBeenCalledWith('circle-1', ['face-a']);
      });
    });

    it('"Delete permanently" opens the confirm dialog and calls purgeFaces on confirm', async () => {
      const archivedFace = makeUnassignedFace({ faceId: 'face-a', mediaItemId: 'media-a' });
      mockListUnassignedFaces.mockImplementation(async (_circleId, opts) => {
        if (opts?.archived) {
          return { items: [archivedFace], meta: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 } };
        }
        return { items: [], meta: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 } };
      });
      mockPurgeFaces.mockResolvedValue({ deleted: 1 });

      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(await screen.findByRole('button', { name: /show archived faces/i }));
      const checkbox = await screen.findByRole('checkbox');
      await user.click(checkbox);

      // Opens the dialog — does not call purgeFaces yet
      await user.click(screen.getByRole('button', { name: /delete permanently/i }));
      expect(mockPurgeFaces).not.toHaveBeenCalled();

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('heading', { name: /delete permanently\?/i })).toBeInTheDocument();

      // Confirm inside the dialog (scoped query avoids matching the trigger button)
      await user.click(within(dialog).getByRole('button', { name: /delete permanently/i }));

      await waitFor(() => {
        expect(mockPurgeFaces).toHaveBeenCalledWith('circle-1', ['face-a']);
      });
    });
  });
});

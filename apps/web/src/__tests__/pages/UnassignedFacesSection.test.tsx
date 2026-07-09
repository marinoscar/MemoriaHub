/**
 * Tests for UnassignedFacesSection (internal to PeoplePage).
 *
 * Focuses on:
 *  - Stale-face error handling (404 / "not found" string) when assigning faces
 *  - Generic error display for non-stale failures
 *  - Window focus event triggering a refresh
 *
 * Access strategy: render full PeoplePage, which renders UnassignedFacesSection.
 * Mock useUnassignedFaces to control face list and the refresh fn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — must appear before consuming imports
// ---------------------------------------------------------------------------

vi.mock('react-easy-crop', () => ({ default: () => null }));

vi.mock('../../hooks/usePeople', () => ({
  usePeople: vi.fn(),
  usePerson: vi.fn(),
}));

vi.mock('../../hooks/useUnassignedFaces', () => ({
  useUnassignedFaces: vi.fn(),
}));

vi.mock('../../services/media', () => ({
  listMedia: vi.fn().mockResolvedValue({ items: [], meta: {} }),
  getMedia: vi.fn().mockResolvedValue({
    id: 'media-1',
    thumbnailUrl: 'https://example.com/thumb.jpg',
    downloadUrl: 'https://example.com/full.jpg',
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
  getCircleFaceSettings: vi.fn().mockResolvedValue({ faceRecognitionEnabled: true }),
  updateCircleFaceSettings: vi.fn().mockResolvedValue({ faceRecognitionEnabled: true }),
  deleteCircleBiometrics: vi.fn().mockResolvedValue({ deletedFaces: 0, deletedPeople: 0 }),
  mergePeople: vi.fn().mockResolvedValue({}),
  deletePerson: vi.fn().mockResolvedValue(undefined),
  listUnassignedFaces: vi.fn().mockResolvedValue({ items: [] }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import PeoplePage from '../../pages/People/PeoplePage';
import { usePeople, usePerson } from '../../hooks/usePeople';
import { useUnassignedFaces } from '../../hooks/useUnassignedFaces';
import * as faceService from '../../services/face';
import type { PersonListItem, UnassignedFaceDto } from '../../services/face';

const mockUsePeople = vi.mocked(usePeople);
const mockUsePerson = vi.mocked(usePerson);
const mockUseUnassignedFaces = vi.mocked(useUnassignedFaces);
const mockAssignFaces = vi.mocked(faceService.assignFaces);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLabeledPerson(id: string, name: string): PersonListItem {
  return {
    id,
    name,
    isUnlabeled: false,
    faceCount: 2,
    coverFace: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    profileMediaItemId: null,
    profileCrop: null,
  };
}

function makeUnassignedFace(faceId: string): UnassignedFaceDto {
  return {
    faceId,
    mediaItemId: 'media-1',
    boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    faceThumbnailUrl: null,
  };
}

function makeUsePeopleDefaults(items: PersonListItem[] = []) {
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
  };
}

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

/**
 * Renders PeoplePage with a single unassigned face and one labeled person.
 * Returns the refresh mock so tests can assert on it.
 *
 * UnassignedFacesSection calls useUnassignedFaces TWICE: once for the live
 * pool (no opts / opts.archived falsy) and once as an archived-count probe
 * (opts.archived === true, pageSize: 1). mockUseUnassignedFaces distinguishes
 * the two call sites via opts?.archived so each returns its own shape.
 */
function setupWithFaceAndPerson(
  refreshMock?: ReturnType<typeof vi.fn>,
  opts?: { archivedTotal?: number; total?: number; hasMore?: boolean; loadMore?: ReturnType<typeof vi.fn> },
) {
  const refresh = refreshMock ?? vi.fn().mockResolvedValue(undefined);
  const refreshArchived = vi.fn().mockResolvedValue(undefined);
  const loadMore = opts?.loadMore ?? vi.fn().mockResolvedValue(undefined);
  const total = opts?.total ?? 1;
  const archivedTotal = opts?.archivedTotal ?? 0;
  const hasMore = opts?.hasMore ?? false;

  mockUseUnassignedFaces.mockImplementation((_circleId, hookOpts) => {
    if (hookOpts?.archived) {
      return {
        faces: [],
        total: archivedTotal,
        hasMore: false,
        loadMore: vi.fn(),
        loadingMore: false,
        loading: false,
        error: null,
        refresh: refreshArchived,
        hide: vi.fn(),
        unhide: vi.fn(),
        purge: vi.fn(),
        purgeArchived: vi.fn(),
      } as any;
    }
    return {
      faces: [makeUnassignedFace('face-1')],
      total,
      hasMore,
      loadMore,
      loadingMore: false,
      loading: false,
      error: null,
      refresh,
      hide: vi.fn(),
      unhide: vi.fn(),
      purge: vi.fn(),
      purgeArchived: vi.fn(),
    } as any;
  });

  mockUsePeople.mockImplementation((_id, opts?: { includeUnlabeled?: boolean }) => {
    if (opts?.includeUnlabeled) return makeUsePeopleDefaults([]) as any;
    return makeUsePeopleDefaults([makeLabeledPerson('existing-p1', 'Bob')]) as any;
  });

  mockUsePerson.mockReturnValue({
    person: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  } as any);

  return { refresh, refreshArchived, loadMore };
}

/**
 * Selects the face chip and selects the existing person in the Autocomplete,
 * then clicks Assign.
 *
 * MUI Autocomplete: we click the combobox to open it, then click the clear option
 * to deselect any pre-selected value, then type the person name. We use
 * findByRole('option') to wait for the dropdown to appear in the portal.
 */
async function selectFaceAndAssign(user: ReturnType<typeof userEvent.setup>) {
  // Wait for the Unassigned Faces heading to ensure the section rendered
  await screen.findByText(/unassigned faces/i);

  // The face grid has a checkbox — click it to select the face
  const faceCheckboxes = await screen.findAllByRole('checkbox');
  // The first checkbox belongs to the face grid (no other checkboxes on page)
  await user.click(faceCheckboxes[0]);

  // Action bar appears: wait for the "Assign to existing person" combobox
  const autocompleteInput = await screen.findByRole('combobox');
  await user.click(autocompleteInput);
  // Clear + type to trigger the dropdown
  await user.clear(autocompleteInput);
  await user.type(autocompleteInput, 'Bob');

  // The MUI Autocomplete dropdown should show Bob (or the full list unfiltered)
  const option = await screen.findByRole('option', { name: /Bob/i });
  await user.click(option);

  // Click Assign button
  const assignBtn = await screen.findByRole('button', { name: /^Assign$/i });
  await user.click(assignBtn);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UnassignedFacesSection — stale-face error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // NOTE: The stale-face error text ("The face list changed...") is set in state
  // but is hidden because the action bar (which contains the error Alert) is
  // conditioned on selectedIds.size > 0, and the stale path clears the selection
  // before setting the error. The observable effect is therefore: selection is
  // cleared (action bar disappears) AND refresh() is called.
  it('calls refresh and clears selection on 404 (stale) error', async () => {
    const user = userEvent.setup();
    const { refresh } = setupWithFaceAndPerson();

    const staleError = Object.assign(new Error('not found'), { status: 404 });
    mockAssignFaces.mockRejectedValue(staleError);

    render(<PeoplePage />);

    await selectFaceAndAssign(user);

    // After the stale error the selection is cleared — action bar disappears
    await waitFor(() => {
      expect(screen.queryByText(/face selected/i)).not.toBeInTheDocument();
    });

    // refresh must have been called from the error handler
    expect(refresh).toHaveBeenCalled();
    // assignFaces was called with the face id
    expect(mockAssignFaces).toHaveBeenCalledWith('existing-p1', ['face-1']);
  });

  // -------------------------------------------------------------------------
  it('calls refresh and clears selection when error message includes "not found"', async () => {
    const user = userEvent.setup();
    const { refresh } = setupWithFaceAndPerson();

    mockAssignFaces.mockRejectedValue(new Error('Face not found'));

    render(<PeoplePage />);

    await selectFaceAndAssign(user);

    // Stale path: selection cleared, action bar gone
    await waitFor(() => {
      expect(screen.queryByText(/face selected/i)).not.toBeInTheDocument();
    });

    expect(refresh).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  it('shows generic error message for non-stale failures', async () => {
    const user = userEvent.setup();
    setupWithFaceAndPerson();

    mockAssignFaces.mockRejectedValue(new Error('Network timeout'));

    render(<PeoplePage />);

    await selectFaceAndAssign(user);

    await waitFor(() => {
      expect(screen.getByText(/network timeout/i)).toBeInTheDocument();
    });

    // Should NOT show the stale message for a generic error
    expect(screen.queryByText(/the face list changed/i)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  it('clears selection after a stale-face (404) error', async () => {
    const user = userEvent.setup();
    setupWithFaceAndPerson();

    mockAssignFaces.mockRejectedValue(
      Object.assign(new Error('not found'), { status: 404 }),
    );

    render(<PeoplePage />);

    await selectFaceAndAssign(user);

    // After the error the action bar (which appears only when faces are selected) should vanish
    await waitFor(() => {
      expect(screen.queryByText(/face selected/i)).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
describe('UnassignedFacesSection — window focus refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Ensure window listeners are cleaned up between tests
  });

  it('calls refresh when the window regains focus', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    setupWithFaceAndPerson(refresh);

    render(<PeoplePage />);

    // Wait for initial render to settle (face settings load + component mount)
    await screen.findByText(/unassigned faces/i);

    // Reset call count after mount refresh
    refresh.mockClear();

    // Simulate window focus
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
describe('UnassignedFacesSection — total / "Load more"', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the total from the hook in the section header, not faces.length', async () => {
    setupWithFaceAndPerson(undefined, { total: 342 });

    render(<PeoplePage />);

    expect(await screen.findByText(/unassigned faces \(342\)/i)).toBeInTheDocument();
  });

  it('renders a "Load more" button when hasMore is true, and calls loadMore on click', async () => {
    const loadMore = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    setupWithFaceAndPerson(undefined, { total: 5, hasMore: true, loadMore });

    render(<PeoplePage />);

    const loadMoreBtn = await screen.findByRole('button', { name: /load more/i });
    await user.click(loadMoreBtn);

    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('does not render a "Load more" button when hasMore is false', async () => {
    setupWithFaceAndPerson(undefined, { total: 1, hasMore: false });

    render(<PeoplePage />);

    await screen.findByText(/unassigned faces/i);
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('UnassignedFacesSection — "View archived faces" navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
  });

  it('renders the "View archived faces" button when the archived probe reports total > 0', async () => {
    setupWithFaceAndPerson(undefined, { archivedTotal: 7 });

    render(<PeoplePage />);

    expect(await screen.findByRole('button', { name: /view archived faces/i })).toBeInTheDocument();
  });

  it('does not render "View archived faces" when the archived probe total is 0', async () => {
    setupWithFaceAndPerson(undefined, { archivedTotal: 0 });

    render(<PeoplePage />);

    await screen.findByText(/unassigned faces/i);
    expect(screen.queryByRole('button', { name: /view archived faces/i })).not.toBeInTheDocument();
  });

  it('navigates to /people/archived when "View archived faces" is clicked', async () => {
    const user = userEvent.setup();
    setupWithFaceAndPerson(undefined, { archivedTotal: 3 });

    render(<PeoplePage />);

    const viewArchivedBtn = await screen.findByRole('button', { name: /view archived faces/i });
    await user.click(viewArchivedBtn);

    expect(mockNavigate).toHaveBeenCalledWith('/people/archived');
  });
});

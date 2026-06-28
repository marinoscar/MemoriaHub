/**
 * Tests for SetProfilePictureDialog (internal to PeoplePage).
 *
 * The dialog is not exported, so we access it through the full PeoplePage by:
 *   1. Rendering PeoplePage with a labeled person present.
 *   2. Clicking the person card to open the PersonDetailDrawer.
 *   3. Clicking "Set profile picture" to open the dialog.
 *
 * Mocking strategy mirrors PeoplePage.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — must be BEFORE imports that consume them
// ---------------------------------------------------------------------------

vi.mock('react-easy-crop', () => ({ default: () => <div data-testid="mock-cropper" /> }));

vi.mock('../../hooks/usePeople', () => ({
  usePeople: vi.fn(),
  usePerson: vi.fn(),
}));

vi.mock('../../hooks/useUnassignedFaces', () => ({
  useUnassignedFaces: vi.fn(),
}));

vi.mock('../../services/media', () => ({
  listMedia: vi.fn(),
  getMedia: vi.fn(),
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

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import PeoplePage from '../../pages/People/PeoplePage';
import { usePeople, usePerson } from '../../hooks/usePeople';
import { useUnassignedFaces } from '../../hooks/useUnassignedFaces';
import * as mediaService from '../../services/media';
import * as faceService from '../../services/face';
import type { PersonListItem, PersonDetail } from '../../services/face';

const mockUsePeople = vi.mocked(usePeople);
const mockUsePerson = vi.mocked(usePerson);
const mockUseUnassignedFaces = vi.mocked(useUnassignedFaces);
const mockListMedia = vi.mocked(mediaService.listMedia);
const mockGetMedia = vi.mocked(mediaService.getMedia);
const mockUpdatePerson = vi.mocked(faceService.updatePerson);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePerson(id: string, name: string): PersonListItem {
  return {
    id,
    name,
    isUnlabeled: false,
    faceCount: 2,
    coverFace: {
      faceId: 'f1',
      mediaItemId: 'media-1',
      boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      faceThumbnailUrl: null,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    profileMediaItemId: null,
    profileCrop: null,
  };
}

function makePersonDetail(id: string = 'p1'): PersonDetail {
  return {
    id,
    name: 'Alice',
    isUnlabeled: false,
    circleId: 'circle-1',
    coverFace: {
      faceId: 'f1',
      mediaItemId: 'media-1',
      boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      faceThumbnailUrl: null,
    },
    faces: [
      {
        faceId: 'f1',
        mediaItemId: 'media-1',
        boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        confidence: null,
        manuallyAssigned: false,
        createdAt: new Date().toISOString(),
        faceThumbnailUrl: null,
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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

function makeUseUnassignedFacesDefaults() {
  return {
    faces: [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Renders PeoplePage with one labeled person and the drawer open on that person.
 * Returns the userEvent instance for further interaction.
 */
async function renderWithDrawerOpen() {
  const user = userEvent.setup();
  render(<PeoplePage />);

  // Wait for face settings to load and the person card to appear
  await screen.findByText('Alice');

  // Click the person card to open the drawer
  await user.click(screen.getByText('Alice'));

  // Wait for the drawer / detail content to appear
  await waitFor(() => {
    expect(mockUsePerson).toHaveBeenCalledWith('p1');
  });

  return user;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SetProfilePictureDialog (via PeoplePage drawer)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: one labeled person
    mockUsePeople.mockImplementation((_circleId, opts?: { includeUnlabeled?: boolean }) => {
      if (opts?.includeUnlabeled) return makeUsePeopleDefaults([]) as any;
      return makeUsePeopleDefaults([makePerson('p1', 'Alice')]) as any;
    });

    mockUsePerson.mockReturnValue({
      person: makePersonDetail('p1') as any,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    } as any);

    mockUseUnassignedFaces.mockReturnValue(makeUseUnassignedFacesDefaults() as any);

    // listMedia returns a couple of thumbnails for the photo picker
    mockListMedia.mockResolvedValue({
      items: [
        {
          id: 'media-pick-1',
          thumbnailUrl: 'https://example.com/thumb-1.jpg',
          downloadUrl: 'https://example.com/full-1.jpg',
        },
        {
          id: 'media-pick-2',
          thumbnailUrl: 'https://example.com/thumb-2.jpg',
          downloadUrl: 'https://example.com/full-2.jpg',
        },
      ],
      meta: { page: 1, pageSize: 50, totalItems: 2, totalPages: 1 },
    } as any);

    // getMedia for the person's cover face AND for the full-res crop step
    mockGetMedia.mockResolvedValue({
      id: 'media-pick-1',
      thumbnailUrl: 'https://example.com/thumb-1.jpg',
      downloadUrl: 'https://example.com/full-1.jpg',
    } as any);

    mockUpdatePerson.mockResolvedValue({
      id: 'p1',
      name: 'Alice',
      coverFaceId: null,
      updatedAt: new Date().toISOString(),
    } as any);
  });

  // -------------------------------------------------------------------------
  it('"Set profile picture" button opens the Pick a photo dialog', async () => {
    const user = await renderWithDrawerOpen();

    const setPicBtn = await screen.findByRole('button', { name: /set profile picture/i });
    await user.click(setPicBtn);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /pick a photo/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  it('photo picker step calls listMedia with the personId', async () => {
    const user = await renderWithDrawerOpen();

    const setPicBtn = await screen.findByRole('button', { name: /set profile picture/i });
    await user.click(setPicBtn);

    // Dialog opens and listMedia is called for this person
    await waitFor(() => {
      expect(mockListMedia).toHaveBeenCalledWith(
        expect.objectContaining({ personId: 'p1' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  it('photo picker shows thumbnails returned by listMedia', async () => {
    const user = await renderWithDrawerOpen();

    const setPicBtn = await screen.findByRole('button', { name: /set profile picture/i });
    await user.click(setPicBtn);

    // Dialog renders <Box component="img" alt=""> — empty alt means role="presentation"
    // Query inside the dialog to avoid picking up PersonAvatar images in the drawer
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      const images = dialog.querySelectorAll('img');
      const srcs = Array.from(images).map((img) => img.src);
      expect(srcs.some((s) => s.includes('thumb-1.jpg'))).toBe(true);
      expect(srcs.some((s) => s.includes('thumb-2.jpg'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  /**
   * Click the first dialog thumbnail to advance to the crop step.
   * The thumbnail <Box component="img" onClick={...}> has onClick on the img element.
   * We use fireEvent.click to avoid userEvent's pointer-events check and
   * scope the query to the dialog element to avoid FaceCrop inner imgs.
   */
  async function clickFirstDialogThumbnail(user: ReturnType<typeof userEvent.setup>) {
    const setPicBtn = await screen.findByRole('button', { name: /set profile picture/i });
    await user.click(setPicBtn);

    const dialog = await screen.findByRole('dialog');

    // Wait for the dialog thumbnails to appear
    await waitFor(() => {
      const images = dialog.querySelectorAll('img');
      expect(Array.from(images).some((img) => img.src.includes('thumb-1.jpg'))).toBe(true);
    });

    // Fire click on the img element itself (onClick is registered on it)
    const thumb1 = Array.from(dialog.querySelectorAll('img')).find((img) =>
      img.src.includes('thumb-1.jpg'),
    )!;
    expect(thumb1).toBeDefined();
    fireEvent.click(thumb1);
  }

  // -------------------------------------------------------------------------
  it('clicking a thumbnail advances to the crop step', async () => {
    const user = await renderWithDrawerOpen();

    await clickFirstDialogThumbnail(user);

    // Dialog title should now say "Crop your photo"
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /crop your photo/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  it('mock-cropper is rendered in the crop step', async () => {
    const user = await renderWithDrawerOpen();

    await clickFirstDialogThumbnail(user);

    await waitFor(() => {
      expect(screen.getByTestId('mock-cropper')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  it('"Use detected face / Clear" calls updatePerson with null profileMediaItemId and null profileCrop', async () => {
    const user = await renderWithDrawerOpen();

    await clickFirstDialogThumbnail(user);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /crop your photo/i })).toBeInTheDocument();
    });

    // Click the "Use detected face / Clear" button
    const clearBtn = screen.getByRole('button', { name: /use detected face \/ clear/i });
    await user.click(clearBtn);

    await waitFor(() => {
      expect(mockUpdatePerson).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ profileMediaItemId: null, profileCrop: null }),
      );
    });
  });
});

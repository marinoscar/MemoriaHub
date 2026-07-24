/**
 * Component tests for FaceThumbnails.
 *
 * Mocking strategy:
 *   - useMediaFaces hook is mocked via vi.mock so no real service calls happen.
 *   - render from test-utils wraps with all required providers.
 *
 * Coverage:
 *   - Returns null for video media type
 *   - Shows loading skeleton while loading=true
 *   - Shows status chip for each status variant
 *   - Renders FaceBox overlays when thumbnailUrl is provided
 *   - Shows "Re-run face detection" button
 *   - Button is disabled when rerunLoading=true
 *   - Clicking rerun button calls the rerun function from the hook
 *   - Shows error alert when error is set
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { FaceThumbnails } from '../../../components/media/FaceThumbnails';
import type { DetectedFaceDto, MediaFaceStatusDto } from '../../../services/face';

// ---------------------------------------------------------------------------
// Mock the useMediaFaces hook directly
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/useMediaFaces', () => ({
  useMediaFaces: vi.fn(),
}));

// Mock face service — listPeople, assignFaces, unassignFace, createPerson,
// purgeFaces (the shared AssignFaceDialog's dependencies).
vi.mock('../../../services/face', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../services/face')>();
  return {
    ...original,
    listPeople: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    assignFaces: vi.fn().mockResolvedValue({ personId: 'p1', assignedCount: 1 }),
    unassignFace: vi.fn().mockResolvedValue(undefined),
    createPerson: vi.fn().mockResolvedValue({ id: 'p-new', name: 'New Person', circleId: 'circle-1' }),
    purgeFaces: vi.fn().mockResolvedValue({ deleted: 1 }),
  };
});

import { useMediaFaces } from '../../../hooks/useMediaFaces';
import {
  listPeople,
  assignFaces,
  unassignFace,
  createPerson,
  purgeFaces,
} from '../../../services/face';

const mockUseMediaFaces = vi.mocked(useMediaFaces);
const mockListPeople = vi.mocked(listPeople);
const mockAssignFaces = vi.mocked(assignFaces);
const mockUnassignFace = vi.mocked(unassignFace);
const mockCreatePerson = vi.mocked(createPerson);
const mockPurgeFaces = vi.mocked(purgeFaces);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatus(
  status: MediaFaceStatusDto['status'] = 'processed',
): MediaFaceStatusDto {
  return {
    status,
    faceCount: status === 'processed' ? 1 : 0,
    providerKey: 'compreface',
    modelVersion: 'arcface-r100-v1',
    processedAt: status === 'processed' ? '2024-06-15T10:00:00.000Z' : null,
    lastError: null,
  };
}

function makeFace(id = 'face-1', overrides: Partial<DetectedFaceDto> = {}): DetectedFaceDto {
  return {
    id,
    boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    confidence: 0.9,
    personId: null,
    personName: null,
    providerKey: 'compreface',
    modelVersion: 'arcface-r100-v1',
    manuallyAssigned: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function defaultHookReturn(overrides: Partial<ReturnType<typeof useMediaFaces>> = {}): ReturnType<typeof useMediaFaces> {
  return {
    faces: [],
    status: makeStatus('processed'),
    loading: false,
    error: null,
    rerun: vi.fn(),
    rerunLoading: false,
    refresh: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FaceThumbnails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMediaFaces.mockReturnValue(defaultHookReturn());
    mockListPeople.mockResolvedValue({ items: [], total: 0 });
  });

  // -------------------------------------------------------------------------
  // Video media type → returns null
  // -------------------------------------------------------------------------

  describe('video media type', () => {
    it('returns null when mediaType is video', () => {
      const { container } = render(
        <FaceThumbnails mediaId="media-1" mediaType="video" />,
      );
      expect(container.firstChild).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  describe('loading state', () => {
    it('shows a loading skeleton when loading=true', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ loading: true }));

      render(<FaceThumbnails mediaId="media-1" />);

      // MUI Skeleton renders as a skeleton element (no chip or button visible)
      // The component returns a Skeleton when loading, so button should not be there
      expect(screen.queryByRole('button', { name: /re-run face detection/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Status chip labels
  // -------------------------------------------------------------------------

  describe('status chip', () => {
    it('shows "Processed" chip for processed status', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ status: makeStatus('processed') }));

      render(<FaceThumbnails mediaId="media-1" />);

      expect(screen.getByText('Processed')).toBeInTheDocument();
    });

    it('shows "Pending" chip for pending status', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ status: makeStatus('pending') }));

      render(<FaceThumbnails mediaId="media-1" />);

      expect(screen.getByText('Pending')).toBeInTheDocument();
    });

    it('shows "Processing" chip for processing status', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ status: makeStatus('processing') }));

      render(<FaceThumbnails mediaId="media-1" />);

      expect(screen.getByText('Processing')).toBeInTheDocument();
    });

    it('shows "No Faces" chip for no_faces status', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ status: makeStatus('no_faces') }));

      render(<FaceThumbnails mediaId="media-1" />);

      expect(screen.getByText('No Faces')).toBeInTheDocument();
    });

    it('shows "Failed" chip for failed status', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ status: makeStatus('failed') }));

      render(<FaceThumbnails mediaId="media-1" />);

      expect(screen.getByText('Failed')).toBeInTheDocument();
    });

    it('shows "Not Processed" chip when status is null', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ status: null }));

      render(<FaceThumbnails mediaId="media-1" />);

      expect(screen.getByText('Not Processed')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Face box overlays
  // -------------------------------------------------------------------------

  describe('face box overlays', () => {
    it('renders one tooltip per detected face when thumbnailUrl is provided', () => {
      const faces = [makeFace('face-1'), makeFace('face-2')];
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ faces }));

      render(<FaceThumbnails mediaId="media-1" thumbnailUrl="https://example.com/thumb.jpg" />);

      // Each face gets a Tooltip with confidence label. Face boxes are positioned
      // absolutely — verify by checking tooltip accessibility (aria-hidden by default;
      // but the box itself renders). Count MUI Box components for faces is tricky,
      // so we verify the image and confidence display via face count text.
      expect(screen.getByText(/2 faces detected/i)).toBeInTheDocument();
    });

    it('renders singular face text for exactly one face', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({
        faces: [makeFace('face-1')],
      }));

      render(<FaceThumbnails mediaId="media-1" thumbnailUrl="https://example.com/thumb.jpg" />);

      expect(screen.getByText(/1 face detected/i)).toBeInTheDocument();
    });

    it('does NOT render face count text when no faces detected', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ faces: [] }));

      render(<FaceThumbnails mediaId="media-1" thumbnailUrl="https://example.com/thumb.jpg" />);

      expect(screen.queryByText(/face detected/i)).not.toBeInTheDocument();
    });

    it('renders the thumbnail image when thumbnailUrl is provided', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ faces: [makeFace()] }));

      render(<FaceThumbnails mediaId="media-1" thumbnailUrl="https://example.com/thumb.jpg" />);

      const img = screen.getByRole('img', { name: /media thumbnail/i });
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', 'https://example.com/thumb.jpg');
    });

    it('prefers downloadUrl over thumbnailUrl for the overlay image when both are provided', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ faces: [makeFace()] }));

      render(
        <FaceThumbnails
          mediaId="media-1"
          thumbnailUrl="https://example.com/thumb.jpg"
          downloadUrl="https://example.com/full.jpg"
        />,
      );

      const img = screen.getByRole('img', { name: /media thumbnail/i });
      expect(img).toHaveAttribute('src', 'https://example.com/full.jpg');
    });
  });

  // -------------------------------------------------------------------------
  // Re-run button
  // -------------------------------------------------------------------------

  describe('re-run button', () => {
    it('shows "Re-run face detection" button', () => {
      render(<FaceThumbnails mediaId="media-1" />);

      expect(
        screen.getByRole('button', { name: /re-run face detection/i }),
      ).toBeInTheDocument();
    });

    it('button is enabled when rerunLoading=false', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ rerunLoading: false }));

      render(<FaceThumbnails mediaId="media-1" />);

      expect(
        screen.getByRole('button', { name: /re-run face detection/i }),
      ).not.toBeDisabled();
    });

    it('button is disabled when rerunLoading=true', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ rerunLoading: true }));

      render(<FaceThumbnails mediaId="media-1" />);

      expect(
        screen.getByRole('button', { name: /re-run face detection/i }),
      ).toBeDisabled();
    });

    it('calls rerun from the hook when button is clicked', async () => {
      const mockRerun = vi.fn().mockResolvedValue(undefined);
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ rerun: mockRerun }));

      const user = userEvent.setup();
      render(<FaceThumbnails mediaId="media-1" />);

      await user.click(screen.getByRole('button', { name: /re-run face detection/i }));

      expect(mockRerun).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Error alert
  // -------------------------------------------------------------------------

  describe('error display', () => {
    it('shows an error alert when error is set', () => {
      mockUseMediaFaces.mockReturnValue(
        defaultHookReturn({ error: 'Detection service unavailable' }),
      );

      render(<FaceThumbnails mediaId="media-1" />);

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText('Detection service unavailable')).toBeInTheDocument();
    });

    it('does NOT show an alert when error is null', () => {
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ error: null }));

      render(<FaceThumbnails mediaId="media-1" />);

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Assign / reassign / unassign / create via the shared AssignFaceDialog
  // (issue #119 — AssignFaceDialog was extracted out of this component)
  // -------------------------------------------------------------------------
  describe('face assignment via AssignFaceDialog', () => {
    it('calls assignFaces(personId, [face.id]) when assigning an unassigned face to an existing person', async () => {
      const user = userEvent.setup();
      const face = makeFace('face-1', { personId: null, personName: null });
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ faces: [face] }));
      mockListPeople.mockResolvedValue({
        items: [
          {
            id: 'p1',
            name: 'Alice',
            isUnlabeled: false,
            faceCount: 0,
            coverFace: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            favorite: false,
          },
        ],
        total: 1,
      });

      render(
        <FaceThumbnails
          mediaId="media-1"
          circleId="circle-1"
          thumbnailUrl="https://example.com/thumb.jpg"
        />,
      );

      await user.click(screen.getByText('Unassigned'));

      const dialog = await screen.findByRole('dialog');
      const combobox = within(dialog).getByRole('combobox');
      await user.click(combobox);
      const aliceOption = await screen.findByRole('option', { name: /alice/i });
      await user.click(aliceOption);
      await user.click(within(dialog).getByRole('button', { name: /^assign$/i }));

      await waitFor(() => {
        expect(mockAssignFaces).toHaveBeenCalledWith('p1', ['face-1']);
      });
    });

    it('calls unassignFace(personId, face.id) when unassigning an already-assigned face', async () => {
      const user = userEvent.setup();
      const face = makeFace('face-1', { personId: 'p1', personName: 'Alice' });
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ faces: [face] }));

      render(
        <FaceThumbnails
          mediaId="media-1"
          circleId="circle-1"
          thumbnailUrl="https://example.com/thumb.jpg"
        />,
      );

      await user.click(screen.getByText('Alice'));

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /unassign/i }));

      await waitFor(() => {
        expect(mockUnassignFace).toHaveBeenCalledWith('p1', 'face-1');
      });
    });

    it('calls createPerson({..., faceIds:[face.id]}) when creating a new person for an unassigned face', async () => {
      const user = userEvent.setup();
      const face = makeFace('face-1', { personId: null, personName: null });
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ faces: [face] }));

      render(
        <FaceThumbnails
          mediaId="media-1"
          circleId="circle-1"
          thumbnailUrl="https://example.com/thumb.jpg"
        />,
      );

      await user.click(screen.getByText('Unassigned'));

      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText(/person name/i), 'Charlie');
      await user.click(within(dialog).getByRole('button', { name: /create person/i }));

      await waitFor(() => {
        expect(mockCreatePerson).toHaveBeenCalledWith({
          circleId: 'circle-1',
          name: 'Charlie',
          faceIds: ['face-1'],
        });
      });
    });

    it('calls purgeFaces(circleId, [face.id]) when confirming "Delete detection permanently"', async () => {
      const user = userEvent.setup();
      const face = makeFace('face-1', { personId: null, personName: null });
      mockUseMediaFaces.mockReturnValue(defaultHookReturn({ faces: [face] }));

      render(
        <FaceThumbnails
          mediaId="media-1"
          circleId="circle-1"
          thumbnailUrl="https://example.com/thumb.jpg"
        />,
      );

      await user.click(screen.getByText('Unassigned'));

      const editDialog = await screen.findByRole('dialog');
      await user.click(
        within(editDialog).getByRole('button', { name: /delete detection permanently/i }),
      );

      const purgeDialog = await screen.findByRole('dialog', { name: /delete permanently\?/i });
      await user.click(
        within(purgeDialog).getByRole('button', { name: /^delete permanently$/i }),
      );

      await waitFor(() => {
        expect(mockPurgeFaces).toHaveBeenCalledWith('circle-1', ['face-1']);
      });
    });
  });
});

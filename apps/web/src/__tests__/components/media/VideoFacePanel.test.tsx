/**
 * Component tests for VideoFacePanel.
 *
 * Coverage:
 *  - Renders "People in this video" section with deduped face rows.
 *  - Shows person name (or "Unassigned" for unknown faces).
 *  - Shows face thumbnail from faceThumbnailUrl when available.
 *  - "Jump to" button calls onSeek with timestampMs/1000 (seconds).
 *  - Unassigned faces also receive a jump-to button when videoTimestampMs is set.
 *  - Manual people association autocomplete is shown when circleId is provided.
 *  - Manual people chip is shown for faces with providerKey='manual'.
 *  - Loading state renders a skeleton.
 *  - Error state renders an alert.
 *  - Deduplication: multiple faces for the same personId → one row, earliest timestamp wins.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { VideoFacePanel } from '../../../components/media/VideoFacePanel';
import type { DetectedFaceDto, MediaFaceStatusDto } from '../../../services/face';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/useMediaFaces', () => ({
  useMediaFaces: vi.fn(),
}));

// Mock face service — listPeople, addPersonToMedia, removePersonFromMedia,
// assignFaces, unassignFace, createPerson, purgeFaces (AssignFaceDialog deps)
vi.mock('../../../services/face', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../services/face')>();
  return {
    ...original,
    listPeople: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    addPersonToMedia: vi.fn().mockResolvedValue({ personId: 'p1', personName: 'Alice', faceId: 'f1', mediaItemId: 'm1' }),
    removePersonFromMedia: vi.fn().mockResolvedValue(undefined),
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
  purgeFaces,
} from '../../../services/face';
const mockUseMediaFaces = vi.mocked(useMediaFaces);
const mockListPeople = vi.mocked(listPeople);
const mockAssignFaces = vi.mocked(assignFaces);
const mockUnassignFace = vi.mocked(unassignFace);
const mockPurgeFaces = vi.mocked(purgeFaces);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStatus(status: MediaFaceStatusDto['status'] = 'processed'): MediaFaceStatusDto {
  return {
    status,
    faceCount: 1,
    providerKey: 'compreface',
    modelVersion: 'arcface-r100-v1',
    processedAt: new Date().toISOString(),
    lastError: null,
  };
}

function makeFace(id: string, overrides: Partial<DetectedFaceDto> = {}): DetectedFaceDto {
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
    videoTimestampMs: 5000,
    videoTimestamps: [5000],
    faceThumbnailUrl: null,
    ...overrides,
  };
}

function defaultHookReturn(
  overrides: Partial<ReturnType<typeof useMediaFaces>> = {},
): ReturnType<typeof useMediaFaces> {
  return {
    faces: [],
    status: makeStatus(),
    loading: false,
    error: null,
    rerun: vi.fn().mockResolvedValue(undefined),
    rerunLoading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: render VideoFacePanel with defaults
// ---------------------------------------------------------------------------

function renderPanel(
  props: Partial<React.ComponentProps<typeof VideoFacePanel>> = {},
  hookOverrides: Partial<ReturnType<typeof useMediaFaces>> = {},
) {
  mockUseMediaFaces.mockReturnValue(defaultHookReturn(hookOverrides));
  return render(
    <VideoFacePanel
      mediaId="media-1"
      durationMs={30000}
      {...props}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VideoFacePanel', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    mockListPeople.mockResolvedValue({ items: [], total: 0 });
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------
  describe('loading state', () => {
    it('renders a skeleton while loading', () => {
      renderPanel({}, { loading: true });
      // MUI Skeleton uses aria role 'progressbar' or has a class; test by absence of face list
      expect(screen.queryByText('People in this video')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------
  describe('error state', () => {
    it('renders an error alert when error is set', () => {
      renderPanel({}, { error: 'Failed to load faces' });
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText('Failed to load faces')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Empty face list
  // -------------------------------------------------------------------------
  describe('empty face list', () => {
    it('does not render "People in this video" section when faces is empty', () => {
      renderPanel({}, { faces: [] });
      expect(screen.queryByText('People in this video')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Person name rendering
  // -------------------------------------------------------------------------
  describe('person name rendering', () => {
    it('shows the person name when a face is assigned to a person', () => {
      const face = makeFace('f1', { personId: 'p1', personName: 'Alice' });
      renderPanel({}, { faces: [face] });
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    it('shows "Unassigned" for a face with no personId', () => {
      const face = makeFace('f2', { personId: null, personName: null });
      renderPanel({}, { faces: [face] });
      expect(screen.getByText('Unassigned')).toBeInTheDocument();
    });

    it('renders "People in this video" heading when detected faces exist', () => {
      const face = makeFace('f1', { personId: 'p1', personName: 'Bob' });
      renderPanel({}, { faces: [face] });
      expect(screen.getByText('People in this video')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Jump-to-timestamp button
  // -------------------------------------------------------------------------
  describe('jump-to-timestamp button', () => {
    it('calls onSeek with timestampMs/1000 when the jump button is clicked', async () => {
      const onSeek = vi.fn();
      const face = makeFace('f1', { personId: 'p1', personName: 'Alice', videoTimestampMs: 7500 });
      renderPanel({ onSeek }, { faces: [face] });

      const seekButton = screen.getByRole('button', { name: /seek to/i });
      fireEvent.click(seekButton);

      expect(onSeek).toHaveBeenCalledWith(7.5); // 7500 ms / 1000 = 7.5 s
    });

    it('calls onSeek with correct seconds for different timestamp values', async () => {
      const onSeek = vi.fn();
      const face = makeFace('f1', { personId: null, personName: null, videoTimestampMs: 12500 });
      renderPanel({ onSeek }, { faces: [face] });

      const seekButton = screen.getByRole('button', { name: /seek to/i });
      fireEvent.click(seekButton);

      expect(onSeek).toHaveBeenCalledWith(12.5);
    });

    it('renders jump button for unassigned faces that have a videoTimestampMs', () => {
      const onSeek = vi.fn();
      const face = makeFace('f2', { personId: null, personName: null, videoTimestampMs: 3000 });
      renderPanel({ onSeek }, { faces: [face] });

      const seekButton = screen.getByRole('button', { name: /seek to/i });
      expect(seekButton).toBeInTheDocument();
    });

    it('does not render jump button when onSeek is not provided', () => {
      const face = makeFace('f1', { personId: 'p1', personName: 'Alice', videoTimestampMs: 5000 });
      renderPanel({ onSeek: undefined }, { faces: [face] });

      expect(screen.queryByRole('button', { name: /seek to/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Deduplication by personId
  // -------------------------------------------------------------------------
  describe('deduplication by personId', () => {
    it('collapses multiple faces with the same personId into one row', () => {
      const face1 = makeFace('f1', { personId: 'p1', personName: 'Alice', videoTimestampMs: 5000 });
      const face2 = makeFace('f2', { personId: 'p1', personName: 'Alice', videoTimestampMs: 10000 });
      renderPanel({}, { faces: [face1, face2] });

      // Alice should appear exactly once
      expect(screen.getAllByText('Alice')).toHaveLength(1);
    });

    it('shows two rows for two different people', () => {
      const face1 = makeFace('f1', { personId: 'p1', personName: 'Alice' });
      const face2 = makeFace('f2', { personId: 'p2', personName: 'Bob' });
      renderPanel({}, { faces: [face1, face2] });

      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    it('uses the earlier timestamp as representative when deduplicating', () => {
      const onSeek = vi.fn();
      // face2 appears at 5000 ms (earlier), face1 at 10000 ms (later)
      const face1 = makeFace('f1', { personId: 'p1', personName: 'Alice', videoTimestampMs: 10000 });
      const face2 = makeFace('f2', { personId: 'p1', personName: 'Alice', videoTimestampMs: 5000 });
      renderPanel({ onSeek }, { faces: [face1, face2] });

      const seekButton = screen.getByRole('button', { name: /seek to/i });
      fireEvent.click(seekButton);

      // Should seek to 5 s (the earlier 5000 ms representative)
      expect(onSeek).toHaveBeenCalledWith(5);
    });
  });

  // -------------------------------------------------------------------------
  // Face thumbnail URL
  // -------------------------------------------------------------------------
  describe('face thumbnail', () => {
    it('renders an Avatar placeholder when faceThumbnailUrl is null', () => {
      const face = makeFace('f1', { personId: 'p1', personName: 'Alice', faceThumbnailUrl: null });
      renderPanel({}, { faces: [face] });
      // FaceCrop not rendered; Avatar placeholder is shown
      expect(screen.queryByRole('img', { name: /face/i })).not.toBeInTheDocument();
    });

    it('does not crash when faceThumbnailUrl is provided (FaceCrop rendered)', () => {
      const face = makeFace('f1', {
        personId: 'p1',
        personName: 'Alice',
        faceThumbnailUrl: 'https://cdn.example.com/thumb.jpg',
      });
      // Should not throw
      expect(() => renderPanel({}, { faces: [face] })).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Manual people association section
  // -------------------------------------------------------------------------
  describe('manual people association', () => {
    it('shows the manual add-person autocomplete when circleId is provided', () => {
      renderPanel({ circleId: 'circle-1' }, { faces: [] });
      expect(screen.getByLabelText(/add a person/i)).toBeInTheDocument();
    });

    it('does not show the add-person section when circleId is not provided', () => {
      renderPanel({ circleId: undefined }, { faces: [] });
      expect(screen.queryByLabelText(/add a person/i)).not.toBeInTheDocument();
    });

    it('shows existing manual-assignment chips', () => {
      const manualFace = makeFace('fm', {
        personId: 'pm',
        personName: 'Charlie',
        providerKey: 'manual',
        manuallyAssigned: true,
      });
      renderPanel({ circleId: 'circle-1' }, { faces: [manualFace] });
      // Charlie should appear as a chip label
      expect(screen.getByText('Charlie')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Re-run button
  // -------------------------------------------------------------------------
  describe('re-run button', () => {
    it('renders the "Re-run face detection" button', () => {
      renderPanel({});
      expect(screen.getByRole('button', { name: /re-run face detection/i })).toBeInTheDocument();
    });

    it('calls rerun when the button is clicked', async () => {
      const rerun = vi.fn().mockResolvedValue(undefined);
      renderPanel({}, { rerun });

      fireEvent.click(screen.getByRole('button', { name: /re-run face detection/i }));

      await waitFor(() => expect(rerun).toHaveBeenCalledTimes(1));
    });

    it('disables the button while rerunLoading=true', () => {
      renderPanel({}, { rerunLoading: true });
      expect(screen.getByRole('button', { name: /re-run face detection/i })).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  // Edit face icon button (issue #119 — AssignFaceDialog integration)
  // -------------------------------------------------------------------------
  describe('edit face icon button', () => {
    it('renders the "Edit face" icon button on a detected row when circleId is provided', () => {
      const face = makeFace('f1', {
        personId: 'p1',
        personName: 'Alice',
        faceThumbnailUrl: 'https://cdn.example.com/f1.jpg',
      });
      renderPanel({ circleId: 'circle-1' }, { faces: [face] });

      expect(screen.getByRole('button', { name: /edit face/i })).toBeInTheDocument();
    });

    it('does not render the "Edit face" icon button when circleId is undefined', () => {
      const face = makeFace('f1', {
        personId: 'p1',
        personName: 'Alice',
        faceThumbnailUrl: 'https://cdn.example.com/f1.jpg',
      });
      renderPanel({ circleId: undefined }, { faces: [face] });

      expect(screen.queryByRole('button', { name: /edit face/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // AssignFaceDialog preview (video uses the Avatar thumbnail, not FaceCrop)
  // -------------------------------------------------------------------------
  describe('edit face dialog preview', () => {
    it('shows the representative-frame Avatar (not FaceCrop) when faceThumbnailUrl is set', async () => {
      const face = makeFace('f1', {
        personId: 'p1',
        personName: 'Alice',
        faceThumbnailUrl: 'https://cdn.example.com/frame.jpg',
      });
      renderPanel({ circleId: 'circle-1' }, { faces: [face] });

      fireEvent.click(screen.getByRole('button', { name: /edit face/i }));

      const dialog = await screen.findByRole('dialog');
      const img = dialog.querySelector('img');
      expect(img).toHaveAttribute('src', 'https://cdn.example.com/frame.jpg');
      // FaceCrop renders role="img" aria-label="Face crop" — must NOT be present
      // for the video path (no imageUrl is passed to AssignFaceDialog).
      expect(within(dialog).queryByRole('img', { name: 'Face crop' })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Reassign flow — operates on every detected face id for the person
  // -------------------------------------------------------------------------
  describe('reassign flow (edit dialog)', () => {
    it('calls assignFaces with all detected face ids belonging to the person, and refreshes', async () => {
      const user = userEvent.setup();
      const face1 = makeFace('f1', { personId: 'p1', personName: 'Alice', videoTimestampMs: 5000 });
      const face2 = makeFace('f2', { personId: 'p1', personName: 'Alice', videoTimestampMs: 10000 });
      mockListPeople.mockResolvedValue({
        items: [
          {
            id: 'p2',
            name: 'Bob',
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
      const onFacesChanged = vi.fn();
      const refresh = vi.fn().mockResolvedValue(undefined);
      renderPanel(
        { circleId: 'circle-1', onFacesChanged },
        { faces: [face1, face2], refresh },
      );

      fireEvent.click(screen.getByRole('button', { name: /edit face/i }));

      const dialog = await screen.findByRole('dialog');
      const combobox = within(dialog).getByRole('combobox');
      await user.click(combobox);
      const bobOption = await screen.findByRole('option', { name: /bob/i });
      await user.click(bobOption);
      await user.click(within(dialog).getByRole('button', { name: /^reassign$/i }));

      await waitFor(() => {
        expect(mockAssignFaces).toHaveBeenCalledTimes(1);
      });
      const [calledPersonId, calledFaceIds] = mockAssignFaces.mock.calls[0];
      expect(calledPersonId).toBe('p2');
      expect([...calledFaceIds].sort()).toEqual(['f1', 'f2']);

      await waitFor(() => {
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(onFacesChanged).toHaveBeenCalledTimes(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Unassign flow — one unassignFace call per detected face id
  // -------------------------------------------------------------------------
  describe('unassign flow (edit dialog)', () => {
    it('calls unassignFace once per detected face id belonging to the person, and refreshes', async () => {
      const face1 = makeFace('f1', { personId: 'p1', personName: 'Alice', videoTimestampMs: 5000 });
      const face2 = makeFace('f2', { personId: 'p1', personName: 'Alice', videoTimestampMs: 10000 });
      const onFacesChanged = vi.fn();
      const refresh = vi.fn().mockResolvedValue(undefined);
      renderPanel(
        { circleId: 'circle-1', onFacesChanged },
        { faces: [face1, face2], refresh },
      );

      fireEvent.click(screen.getByRole('button', { name: /edit face/i }));

      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: /unassign/i }));

      await waitFor(() => {
        expect(mockUnassignFace).toHaveBeenCalledTimes(2);
      });
      expect(mockUnassignFace).toHaveBeenCalledWith('p1', 'f1');
      expect(mockUnassignFace).toHaveBeenCalledWith('p1', 'f2');

      await waitFor(() => {
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(onFacesChanged).toHaveBeenCalledTimes(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Permanent delete flow — purgeFaces via the nested PurgeFacesDialog confirm
  // -------------------------------------------------------------------------
  describe('permanent delete flow (edit dialog)', () => {
    it('calls purgeFaces with all detected face ids after confirming, and refreshes', async () => {
      const face1 = makeFace('f1', { personId: 'p1', personName: 'Alice', videoTimestampMs: 5000 });
      const face2 = makeFace('f2', { personId: 'p1', personName: 'Alice', videoTimestampMs: 10000 });
      const onFacesChanged = vi.fn();
      const refresh = vi.fn().mockResolvedValue(undefined);
      renderPanel(
        { circleId: 'circle-1', onFacesChanged },
        { faces: [face1, face2], refresh },
      );

      fireEvent.click(screen.getByRole('button', { name: /edit face/i }));

      const editDialog = await screen.findByRole('dialog');
      fireEvent.click(
        within(editDialog).getByRole('button', { name: /delete detection permanently/i }),
      );

      const purgeDialog = await screen.findByRole('dialog', { name: /delete permanently\?/i });
      fireEvent.click(
        within(purgeDialog).getByRole('button', { name: /^delete permanently$/i }),
      );

      await waitFor(() => {
        expect(mockPurgeFaces).toHaveBeenCalledTimes(1);
      });
      const [calledCircleId, calledFaceIds] = mockPurgeFaces.mock.calls[0];
      expect(calledCircleId).toBe('circle-1');
      expect([...calledFaceIds].sort()).toEqual(['f1', 'f2']);

      await waitFor(() => {
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(onFacesChanged).toHaveBeenCalledTimes(1);
      });
    });
  });
});

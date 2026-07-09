/**
 * Tests for ArchivedFacesPage (standalone route at /people/archived).
 *
 * This page replaces the old inline "show archived faces" Collapse sub-view
 * that used to live inside PeoplePage's UnassignedFacesSection. It manages
 * the full archived-faces pool: grid + selection, restore, delete-permanently
 * (single confirm via PurgeFacesDialog), and delete-all-archived (via
 * purgeArchived()).
 *
 * Mocking strategy mirrors UnassignedFacesSection.test.tsx: mock
 * useUnassignedFaces as a hook directly rather than exercising the real hook
 * + service, and use the repo's render() from test-utils for circle context
 * (MockCircleProvider already supplies useCircle()/useCircleContext()).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — must appear before consuming imports
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useUnassignedFaces', () => ({
  useUnassignedFaces: vi.fn(),
}));

vi.mock('../../services/media', () => ({
  getMedia: vi.fn().mockResolvedValue({
    id: 'media-1',
    thumbnailUrl: 'https://example.com/thumb.jpg',
    downloadUrl: null,
  }),
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

import ArchivedFacesPage from '../../pages/People/ArchivedFacesPage';
import { useUnassignedFaces } from '../../hooks/useUnassignedFaces';
import type { UnassignedFaceDto } from '../../services/face';

const mockUseUnassignedFaces = vi.mocked(useUnassignedFaces);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFace(faceId: string): UnassignedFaceDto {
  return {
    faceId,
    mediaItemId: `media-${faceId}`,
    boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    faceThumbnailUrl: 'https://example.com/face.jpg',
    hiddenAt: new Date().toISOString(),
  };
}

function makeHookReturn(overrides: Record<string, unknown> = {}) {
  return {
    faces: [makeFace('face-a')],
    total: 1,
    hasMore: false,
    loadMore: vi.fn().mockResolvedValue(undefined),
    loadingMore: false,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    unhide: vi.fn().mockResolvedValue({ unhidden: 1 }),
    purge: vi.fn().mockResolvedValue({ deleted: 1 }),
    purgeArchived: vi.fn().mockResolvedValue({ deleted: 0 }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArchivedFacesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUnassignedFaces.mockReturnValue(makeHookReturn() as any);
  });

  it('shows "Select a circle" text when there is no active circle', () => {
    render(<ArchivedFacesPage />, {
      wrapperOptions: { activeCircle: null, activeCircleRole: null },
    });

    expect(screen.getByText(/select a circle to view archived faces/i)).toBeInTheDocument();
  });

  it('renders the grid and the total count in the title', async () => {
    mockUseUnassignedFaces.mockReturnValue(
      makeHookReturn({
        faces: [makeFace('face-a'), makeFace('face-b')],
        total: 2,
      }) as any,
    );

    render(<ArchivedFacesPage />);

    expect(await screen.findByRole('heading', { name: /archived faces \(2\)/i })).toBeInTheDocument();
    // One checkbox per face in the grid
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('shows the empty state when total is 0', async () => {
    mockUseUnassignedFaces.mockReturnValue(makeHookReturn({ faces: [], total: 0 }) as any);

    render(<ArchivedFacesPage />);

    expect(await screen.findByText(/no archived faces/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('selecting a face then clicking Restore calls unhide then refresh', async () => {
    const unhide = vi.fn().mockResolvedValue({ unhidden: 1 });
    const refresh = vi.fn().mockResolvedValue(undefined);
    mockUseUnassignedFaces.mockReturnValue(makeHookReturn({ unhide, refresh }) as any);

    const user = userEvent.setup();
    render(<ArchivedFacesPage />);

    const checkbox = await screen.findByRole('checkbox');
    await user.click(checkbox);

    const restoreBtn = await screen.findByRole('button', { name: /^restore$/i });
    await user.click(restoreBtn);

    await waitFor(() => {
      expect(unhide).toHaveBeenCalledWith(['face-a']);
    });
    expect(refresh).toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByText(/restored 1 face/i)).toBeInTheDocument();
    });
  });

  it('"Delete permanently" opens PurgeFacesDialog and confirming calls purge', async () => {
    const purge = vi.fn().mockResolvedValue({ deleted: 1 });
    const refresh = vi.fn().mockResolvedValue(undefined);
    mockUseUnassignedFaces.mockReturnValue(makeHookReturn({ purge, refresh }) as any);

    const user = userEvent.setup();
    render(<ArchivedFacesPage />);

    const checkbox = await screen.findByRole('checkbox');
    await user.click(checkbox);

    await user.click(screen.getByRole('button', { name: /delete permanently/i }));
    expect(purge).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /delete permanently\?/i })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /delete permanently/i }));

    await waitFor(() => {
      expect(purge).toHaveBeenCalledWith(['face-a']);
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('"Delete all archived" opens a confirm dialog and confirming calls purgeArchived, showing the deleted count in a snackbar', async () => {
    const purgeArchived = vi.fn().mockResolvedValue({ deleted: 9 });
    const refresh = vi.fn().mockResolvedValue(undefined);
    mockUseUnassignedFaces.mockReturnValue(
      makeHookReturn({ purgeArchived, refresh, total: 9 }) as any,
    );

    const user = userEvent.setup();
    render(<ArchivedFacesPage />);

    const deleteAllBtn = await screen.findByRole('button', { name: /delete all archived/i });
    await user.click(deleteAllBtn);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/delete all archived faces\?/i)).toBeInTheDocument();
    expect(purgeArchived).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /delete all/i }));

    await waitFor(() => {
      expect(purgeArchived).toHaveBeenCalledTimes(1);
    });
    expect(refresh).toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByText(/permanently deleted 9 face/i)).toBeInTheDocument();
    });
  });

  it('does not render the "Delete all archived" button for a viewer role', async () => {
    render(<ArchivedFacesPage />, { wrapperOptions: { activeCircleRole: 'viewer' } });

    await screen.findByRole('heading', { name: /archived faces/i });
    expect(screen.queryByRole('button', { name: /delete all archived/i })).not.toBeInTheDocument();
  });

  it('does not render Restore / Delete permanently action buttons for a viewer role', async () => {
    const user = userEvent.setup();
    render(<ArchivedFacesPage />, { wrapperOptions: { activeCircleRole: 'viewer' } });

    const checkbox = await screen.findByRole('checkbox');
    await user.click(checkbox);

    expect(screen.queryByRole('button', { name: /^restore$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete permanently/i })).not.toBeInTheDocument();
  });
});

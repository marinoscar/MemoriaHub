/**
 * RTL tests for TrashPage (issue #165 — Empty Trash at scale).
 *
 * Covers:
 *   - Confirming "Empty Trash" calls createTrashEmptyRun and navigates to
 *     /trash/runs/:runId on success.
 *   - A 409 (ApiError) from createTrashEmptyRun shows the "already in
 *     progress" message via the Snackbar, instead of navigating.
 *   - A non-409 error shows a generic failure message.
 *   - The "Empty Trash" button is hidden for a non-circle_admin.
 *
 * MediaGallery is mocked out (mirrors the HomePage.test.tsx precedent) since
 * its own data-fetching behavior is unrelated to this page's empty-trash flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { ApiError } from '../../../services/api';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../../services/trashEmptyRuns', () => ({
  createTrashEmptyRun: vi.fn(),
}));

vi.mock('../../../services/media', () => ({
  listTrash: vi.fn().mockResolvedValue({ items: [], meta: { totalPages: 1 } }),
}));

vi.mock('../../../components/media/MediaGallery', () => ({
  MediaGallery: vi.fn(({ emptyState }: { emptyState?: React.ReactNode }) => (
    <div data-testid="media-gallery">{emptyState}</div>
  )),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import TrashPage from '../../../pages/Trash/TrashPage';
import { useCircle } from '../../../hooks/useCircle';
import { createTrashEmptyRun } from '../../../services/trashEmptyRuns';

const mockUseCircle = vi.mocked(useCircle);
const mockCreateTrashEmptyRun = vi.mocked(createTrashEmptyRun);

function makeCircleContext(overrides: Partial<ReturnType<typeof useCircle>> = {}) {
  return {
    activeCircle: {
      id: 'circle-1',
      name: 'Test Circle',
      description: null,
      ownerId: 'user-1',
      isPersonal: false,
      createdAt: '',
      updatedAt: '',
    },
    activeCircleId: 'circle-1',
    activeCircleRole: 'circle_admin',
    circles: [],
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ReturnType<typeof useCircle>;
}

describe('TrashPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCircle.mockReturnValue(makeCircleContext());
  });

  it('shows the Empty Trash button for a circle_admin', () => {
    render(<TrashPage />);
    expect(screen.getByRole('button', { name: /empty trash/i })).toBeInTheDocument();
  });

  it('hides the Empty Trash button for a non-circle_admin', () => {
    mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleRole: 'collaborator' }));
    render(<TrashPage />);
    expect(screen.queryByRole('button', { name: /empty trash/i })).not.toBeInTheDocument();
  });

  it('confirming the dialog calls createTrashEmptyRun and navigates to /trash/runs/:runId on success', async () => {
    const user = userEvent.setup();
    mockCreateTrashEmptyRun.mockResolvedValue({
      runId: 'run-abc',
      status: 'evaluating',
      matchedCount: 0,
    });

    render(<TrashPage />);

    await user.click(screen.getByRole('button', { name: /empty trash/i }));
    expect(screen.getByText('Empty Trash?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /delete all/i }));

    await waitFor(() => {
      expect(mockCreateTrashEmptyRun).toHaveBeenCalledWith({ circleId: 'circle-1' });
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/trash/runs/run-abc');
    });
  });

  it('closes the confirm dialog without calling createTrashEmptyRun when Cancel is clicked', async () => {
    const user = userEvent.setup();
    render(<TrashPage />);

    await user.click(screen.getByRole('button', { name: /empty trash/i }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(mockCreateTrashEmptyRun).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows the "already in progress" message on a 409 conflict and does NOT navigate', async () => {
    const user = userEvent.setup();
    mockCreateTrashEmptyRun.mockRejectedValue(
      new ApiError('Conflict', 409, 'CONFLICT'),
    );

    render(<TrashPage />);

    await user.click(screen.getByRole('button', { name: /empty trash/i }));
    await user.click(screen.getByRole('button', { name: /delete all/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/an empty-trash run is already in progress for this circle/i),
      ).toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows a generic failure message on a non-409 error', async () => {
    const user = userEvent.setup();
    mockCreateTrashEmptyRun.mockRejectedValue(new Error('Network error'));

    render(<TrashPage />);

    await user.click(screen.getByRole('button', { name: /empty trash/i }));
    await user.click(screen.getByRole('button', { name: /delete all/i }));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows a prompt to select a circle when no circle is active', () => {
    mockUseCircle.mockReturnValue(makeCircleContext({ activeCircleId: null }));
    render(<TrashPage />);
    expect(screen.getByText(/select a circle to view the trash/i)).toBeInTheDocument();
  });
});

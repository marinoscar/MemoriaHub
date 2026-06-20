/**
 * Component tests for TagsBrowsePage (/tags).
 *
 * TagsBrowsePage:
 *  - Requires an active circle (shows an alert when none).
 *  - Loads tags via getExploreTags(circleId).
 *  - Shows a grid of tag tiles; each tile navigates to /media?tag=<name>.
 *  - Shows a loading skeleton while fetching.
 *  - Shows an empty-state message when no tags are returned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { render } from '../../../__tests__/utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks (must precede the imports that use them)
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../../services/media', () => ({
  getExploreTags: vi.fn(),
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

import TagsBrowsePage from '../TagsBrowsePage';
import { useCircle } from '../../../hooks/useCircle';
import { getExploreTags } from '../../../services/media';

const mockUseCircle = vi.mocked(useCircle);
const mockGetExploreTags = vi.mocked(getExploreTags);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function defaultCircleMock() {
  return {
    activeCircle: { id: 'circle-1', name: 'My Circle' },
    activeCircleId: 'circle-1',
    activeCircleRole: 'circle_admin' as const,
    circles: [],
    loading: false,
    setActiveCircle: vi.fn(),
    refreshCircles: vi.fn(),
  };
}

// ---------------------------------------------------------------------------

describe('TagsBrowsePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
    // Default: resolve with an empty list so tests that need data can override
    mockGetExploreTags.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // No-circle guard
  // -------------------------------------------------------------------------
  describe('No active circle', () => {
    it('shows an info alert when no circle is active', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<TagsBrowsePage />);

      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert.textContent).toMatch(/select a circle/i);
    });

    it('does not call getExploreTags when no circle is active', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<TagsBrowsePage />);

      expect(mockGetExploreTags).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Page heading
  // -------------------------------------------------------------------------
  describe('Page title', () => {
    it('renders a Tags heading', async () => {
      render(<TagsBrowsePage />);

      // The page title is rendered synchronously; tags load async
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /tags/i })).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Data rendering
  // -------------------------------------------------------------------------
  describe('Tag tiles', () => {
    it('renders tag tiles after the service resolves', async () => {
      mockGetExploreTags.mockResolvedValue([
        { name: 'beach', count: 12, coverThumbnailUrl: null },
        { name: 'sunset', count: 5, coverThumbnailUrl: null },
      ]);

      render(<TagsBrowsePage />);

      await waitFor(() => {
        expect(screen.getByText('beach')).toBeInTheDocument();
        expect(screen.getByText('sunset')).toBeInTheDocument();
      });
    });

    it('calls getExploreTags with the active circle id', async () => {
      render(<TagsBrowsePage />);

      await waitFor(() => {
        expect(mockGetExploreTags).toHaveBeenCalledWith('circle-1');
      });
    });

    it('navigates to /media?tag=<name> when a tag tile is clicked', async () => {
      mockGetExploreTags.mockResolvedValue([
        { name: 'mountain', count: 3, coverThumbnailUrl: null },
      ]);

      render(<TagsBrowsePage />);

      await waitFor(() => {
        expect(screen.getByText('mountain')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /browse photos tagged mountain/i }));

      expect(mockNavigate).toHaveBeenCalledWith('/media?tag=mountain');
    });

    it('URL-encodes the tag name in the navigation target', async () => {
      mockGetExploreTags.mockResolvedValue([
        { name: 'summer vibes', count: 1, coverThumbnailUrl: null },
      ]);

      render(<TagsBrowsePage />);

      await waitFor(() => {
        expect(screen.getByText('summer vibes')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /browse photos tagged summer vibes/i }));

      expect(mockNavigate).toHaveBeenCalledWith('/media?tag=summer%20vibes');
    });
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------
  describe('Empty state', () => {
    it('shows "No tags yet" when the service returns an empty list', async () => {
      mockGetExploreTags.mockResolvedValue([]);

      render(<TagsBrowsePage />);

      await waitFor(() => {
        expect(screen.getByText(/no tags yet/i)).toBeInTheDocument();
      });
    });

    it('does not show the empty-state message while loading', () => {
      // Make the service never resolve during this synchronous test
      mockGetExploreTags.mockReturnValue(new Promise(() => {}));

      render(<TagsBrowsePage />);

      // Loading skeletons are shown; the empty-state text should not be present yet
      expect(screen.queryByText(/no tags yet/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------
  describe('Error handling', () => {
    it('shows an error alert when the service rejects', async () => {
      mockGetExploreTags.mockRejectedValue(new Error('Network error'));

      render(<TagsBrowsePage />);

      await waitFor(() => {
        const alert = screen.getByRole('alert');
        expect(alert.textContent).toMatch(/failed to load tags/i);
      });
    });

    it('does not show tag tiles after an error', async () => {
      mockGetExploreTags.mockRejectedValue(new Error('fail'));

      render(<TagsBrowsePage />);

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /browse photos tagged/i })).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Circle change
  // -------------------------------------------------------------------------
  describe('Circle change', () => {
    it('re-fetches tags when the active circle changes', async () => {
      const { rerender } = render(<TagsBrowsePage />);

      await waitFor(() => expect(mockGetExploreTags).toHaveBeenCalledTimes(1));

      // Simulate switching to a different circle
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: { id: 'circle-2', name: 'Other Circle' },
        activeCircleId: 'circle-2',
      } as any);

      rerender(<TagsBrowsePage />);

      await waitFor(() => expect(mockGetExploreTags).toHaveBeenCalledTimes(2));
      expect(mockGetExploreTags).toHaveBeenLastCalledWith('circle-2');
    });
  });
});

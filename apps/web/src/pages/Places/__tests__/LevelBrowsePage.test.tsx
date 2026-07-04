/**
 * Component tests for LevelBrowsePage (/places/countries|regions|cities).
 *
 * LevelBrowsePage is parameterized by a `level` prop (countries | regions |
 * cities). It mirrors the TagsBrowsePage grid template:
 *  - Requires an active circle (shows a level-specific alert when none).
 *  - Loads the full tier via getExploreLocationLevel(circleId, level).
 *  - Renders a responsive grid of location tiles; each tile navigates to the
 *    media library filtered by the tapped location (country|region|locality
 *    query param depending on level).
 *  - Shows loading skeletons while fetching and a level-specific empty state.
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
  getExploreLocationLevel: vi.fn(),
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

import LevelBrowsePage from '../LevelBrowsePage';
import { useCircle } from '../../../hooks/useCircle';
import { getExploreLocationLevel } from '../../../services/media';

const mockUseCircle = vi.mocked(useCircle);
const mockGetExploreLocationLevel = vi.mocked(getExploreLocationLevel);

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

describe('LevelBrowsePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
    mockGetExploreLocationLevel.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // level="countries"
  // -------------------------------------------------------------------------
  describe('level="countries"', () => {
    it('renders a Countries heading', async () => {
      render(<LevelBrowsePage level="countries" />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /countries/i })).toBeInTheDocument();
      });
    });

    it('calls getExploreLocationLevel with circleId and "countries"', async () => {
      render(<LevelBrowsePage level="countries" />);

      await waitFor(() => {
        expect(mockGetExploreLocationLevel).toHaveBeenCalledWith('circle-1', 'countries');
      });
    });

    it('renders a grid tile for each returned country', async () => {
      mockGetExploreLocationLevel.mockResolvedValue([
        { name: 'France', countryCode: 'FR', count: 20, coverThumbnailUrl: null },
        { name: 'Costa Rica', countryCode: 'CR', count: 15, coverThumbnailUrl: null },
      ]);

      render(<LevelBrowsePage level="countries" />);

      await waitFor(() => {
        expect(screen.getByText('France')).toBeInTheDocument();
        expect(screen.getByText('Costa Rica')).toBeInTheDocument();
      });
    });

    it('navigates to /media?country=<name> when a tile is clicked', async () => {
      mockGetExploreLocationLevel.mockResolvedValue([
        { name: 'France', countryCode: 'FR', count: 20, coverThumbnailUrl: null },
      ]);

      render(<LevelBrowsePage level="countries" />);

      await waitFor(() => {
        expect(screen.getByText('France')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /browse photos from france/i }));

      expect(mockNavigate).toHaveBeenCalledWith('/media?country=France');
    });

    it('shows the "No countries yet" empty state when the list is empty', async () => {
      render(<LevelBrowsePage level="countries" />);

      await waitFor(() => {
        expect(screen.getByText(/no countries yet/i)).toBeInTheDocument();
      });
    });

    it('shows the countries-specific no-circle guard', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<LevelBrowsePage level="countries" />);

      expect(screen.getByRole('alert').textContent).toMatch(/select a circle to view countries/i);
    });
  });

  // -------------------------------------------------------------------------
  // level="cities"
  // -------------------------------------------------------------------------
  describe('level="cities"', () => {
    it('renders a Cities heading', async () => {
      render(<LevelBrowsePage level="cities" />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /cities/i })).toBeInTheDocument();
      });
    });

    it('calls getExploreLocationLevel with circleId and "cities"', async () => {
      render(<LevelBrowsePage level="cities" />);

      await waitFor(() => {
        expect(mockGetExploreLocationLevel).toHaveBeenCalledWith('circle-1', 'cities');
      });
    });

    it('renders a grid tile for each returned city', async () => {
      mockGetExploreLocationLevel.mockResolvedValue([
        { name: 'Liberia', count: 9, coverThumbnailUrl: null },
        { name: 'Heredia', count: 3, coverThumbnailUrl: null },
      ]);

      render(<LevelBrowsePage level="cities" />);

      await waitFor(() => {
        expect(screen.getByText('Liberia')).toBeInTheDocument();
        expect(screen.getByText('Heredia')).toBeInTheDocument();
      });
    });

    it('navigates to /media?locality=<name> when a tile is clicked', async () => {
      mockGetExploreLocationLevel.mockResolvedValue([
        { name: 'Liberia', count: 9, coverThumbnailUrl: null },
      ]);

      render(<LevelBrowsePage level="cities" />);

      await waitFor(() => {
        expect(screen.getByText('Liberia')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /browse photos from liberia/i }));

      expect(mockNavigate).toHaveBeenCalledWith('/media?locality=Liberia');
    });

    it('URL-encodes the city name in the navigation target', async () => {
      mockGetExploreLocationLevel.mockResolvedValue([
        { name: 'San José', count: 5, coverThumbnailUrl: null },
      ]);

      render(<LevelBrowsePage level="cities" />);

      await waitFor(() => {
        expect(screen.getByText('San José')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /browse photos from san josé/i }));

      expect(mockNavigate).toHaveBeenCalledWith(
        `/media?locality=${encodeURIComponent('San José')}`,
      );
    });

    it('shows the "No cities yet" empty state when the list is empty', async () => {
      render(<LevelBrowsePage level="cities" />);

      await waitFor(() => {
        expect(screen.getByText(/no cities yet/i)).toBeInTheDocument();
      });
    });

    it('shows the cities-specific no-circle guard', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<LevelBrowsePage level="cities" />);

      expect(screen.getByRole('alert').textContent).toMatch(/select a circle to view cities/i);
    });
  });

  // -------------------------------------------------------------------------
  // level="regions" (lighter coverage — same shared implementation)
  // -------------------------------------------------------------------------
  describe('level="regions"', () => {
    it('renders a Regions heading and navigates to /media?region=<name>', async () => {
      mockGetExploreLocationLevel.mockResolvedValue([
        { name: 'Guanacaste', count: 6, coverThumbnailUrl: null },
      ]);

      render(<LevelBrowsePage level="regions" />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /regions/i })).toBeInTheDocument();
        expect(screen.getByText('Guanacaste')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /browse photos from guanacaste/i }));

      expect(mockNavigate).toHaveBeenCalledWith('/media?region=Guanacaste');
    });

    it('calls getExploreLocationLevel with circleId and "regions"', async () => {
      render(<LevelBrowsePage level="regions" />);

      await waitFor(() => {
        expect(mockGetExploreLocationLevel).toHaveBeenCalledWith('circle-1', 'regions');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------
  describe('Loading state', () => {
    it('does not show the empty-state message while loading', () => {
      mockGetExploreLocationLevel.mockReturnValue(new Promise(() => {}));

      render(<LevelBrowsePage level="countries" />);

      expect(screen.queryByText(/no countries yet/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------
  describe('Error handling', () => {
    it('shows an error alert when the service rejects', async () => {
      mockGetExploreLocationLevel.mockRejectedValue(new Error('Network error'));

      render(<LevelBrowsePage level="countries" />);

      await waitFor(() => {
        const alert = screen.getByRole('alert');
        expect(alert.textContent).toMatch(/failed to load countries/i);
      });
    });
  });

  // -------------------------------------------------------------------------
  // No-circle guard (generic — does not call the service)
  // -------------------------------------------------------------------------
  describe('No active circle', () => {
    it('does not call getExploreLocationLevel when no circle is active', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<LevelBrowsePage level="countries" />);

      expect(mockGetExploreLocationLevel).not.toHaveBeenCalled();
    });
  });
});

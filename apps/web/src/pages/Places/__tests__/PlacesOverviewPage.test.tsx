/**
 * Component tests for PlacesOverviewPage (/places).
 *
 * PlacesOverviewPage:
 *  - Requires an active circle (shows an alert when none).
 *  - Loads tiered locations via getExploreLocations(circleId).
 *  - Renders three ExploreCarousel rows: Countries / Regions / Cities.
 *  - Each row's "Show all" button navigates to /places/countries|regions|cities.
 *  - Shows a loading skeleton while fetching and an error alert on failure.
 *
 * Note: useFittedCount seeds from getBoundingClientRect().width, which is 0 in
 * jsdom, clamping the visible tile count to 1 per row. Tests that assert tile
 * content therefore use a single-item array for the row under test (mirrors
 * the convention used in SearchPage tests).
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
  getExploreLocations: vi.fn(),
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

import PlacesOverviewPage from '../PlacesOverviewPage';
import { useCircle } from '../../../hooks/useCircle';
import { getExploreLocations } from '../../../services/media';

const mockUseCircle = vi.mocked(useCircle);
const mockGetExploreLocations = vi.mocked(getExploreLocations);

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

function emptyLocations() {
  return { countries: [], regions: [], cities: [] };
}

// ---------------------------------------------------------------------------

describe('PlacesOverviewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
    mockGetExploreLocations.mockResolvedValue(emptyLocations());
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

      render(<PlacesOverviewPage />);

      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert.textContent).toMatch(/select a circle/i);
    });

    it('does not call getExploreLocations when no circle is active', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<PlacesOverviewPage />);

      expect(mockGetExploreLocations).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Page heading + row titles
  // -------------------------------------------------------------------------
  describe('Page title and row headers', () => {
    it('renders a Places heading', async () => {
      render(<PlacesOverviewPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /places/i })).toBeInTheDocument();
      });
    });

    it('renders Countries, Regions, and Cities row titles', async () => {
      render(<PlacesOverviewPage />);

      await waitFor(() => {
        expect(screen.getByText('Countries')).toBeInTheDocument();
        expect(screen.getByText('Regions')).toBeInTheDocument();
        expect(screen.getByText('Cities')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Data rendering
  // -------------------------------------------------------------------------
  describe('Location tiles', () => {
    it('calls getExploreLocations with the active circle id', async () => {
      render(<PlacesOverviewPage />);

      await waitFor(() => {
        expect(mockGetExploreLocations).toHaveBeenCalledWith('circle-1');
      });
    });

    it('renders a country tile with name and count', async () => {
      mockGetExploreLocations.mockResolvedValue({
        countries: [{ name: 'France', countryCode: 'FR', count: 12, coverThumbnailUrl: null }],
        regions: [],
        cities: [],
      });

      render(<PlacesOverviewPage />);

      await waitFor(() => {
        expect(screen.getByText('France')).toBeInTheDocument();
        expect(screen.getByText('12')).toBeInTheDocument();
      });
    });

    it('renders a region tile with name and count', async () => {
      mockGetExploreLocations.mockResolvedValue({
        countries: [],
        regions: [{ name: 'Guanacaste', count: 8, coverThumbnailUrl: null }],
        cities: [],
      });

      render(<PlacesOverviewPage />);

      await waitFor(() => {
        expect(screen.getByText('Guanacaste')).toBeInTheDocument();
        expect(screen.getByText('8')).toBeInTheDocument();
      });
    });

    it('renders a city tile with name and count', async () => {
      mockGetExploreLocations.mockResolvedValue({
        countries: [],
        regions: [],
        cities: [{ name: 'Liberia', count: 4, coverThumbnailUrl: null }],
      });

      render(<PlacesOverviewPage />);

      await waitFor(() => {
        expect(screen.getByText('Liberia')).toBeInTheDocument();
        expect(screen.getByText('4')).toBeInTheDocument();
      });
    });

    it('navigates to /media?country=<name> when a country tile is clicked', async () => {
      mockGetExploreLocations.mockResolvedValue({
        countries: [{ name: 'France', countryCode: 'FR', count: 12, coverThumbnailUrl: null }],
        regions: [],
        cities: [],
      });

      render(<PlacesOverviewPage />);

      await waitFor(() => {
        expect(screen.getByText('France')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /browse photos from france/i }));

      expect(mockNavigate).toHaveBeenCalledWith('/media?country=France');
    });

    it('navigates to /media?region=<name> when a region tile is clicked', async () => {
      mockGetExploreLocations.mockResolvedValue({
        countries: [],
        regions: [{ name: 'Guanacaste', count: 8, coverThumbnailUrl: null }],
        cities: [],
      });

      render(<PlacesOverviewPage />);

      await waitFor(() => {
        expect(screen.getByText('Guanacaste')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /browse photos from guanacaste/i }));

      expect(mockNavigate).toHaveBeenCalledWith('/media?region=Guanacaste');
    });

    it('navigates to /media?locality=<name> when a city tile is clicked', async () => {
      mockGetExploreLocations.mockResolvedValue({
        countries: [],
        regions: [],
        cities: [{ name: 'Liberia', count: 4, coverThumbnailUrl: null }],
      });

      render(<PlacesOverviewPage />);

      await waitFor(() => {
        expect(screen.getByText('Liberia')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /browse photos from liberia/i }));

      expect(mockNavigate).toHaveBeenCalledWith('/media?locality=Liberia');
    });
  });

  // -------------------------------------------------------------------------
  // "Show all" buttons
  // -------------------------------------------------------------------------
  describe('Show all navigation', () => {
    it('navigates to /places/countries when the Countries "Show all" is clicked', async () => {
      mockGetExploreLocations.mockResolvedValue({
        countries: [{ name: 'France', countryCode: 'FR', count: 12, coverThumbnailUrl: null }],
        regions: [],
        cities: [],
      });

      render(<PlacesOverviewPage />);

      const showAllButtons = await screen.findAllByRole('button', { name: /show all/i });
      fireEvent.click(showAllButtons[0]);

      expect(mockNavigate).toHaveBeenCalledWith('/places/countries');
    });

    it('navigates to /places/regions when the Regions "Show all" is clicked', async () => {
      mockGetExploreLocations.mockResolvedValue({
        countries: [],
        regions: [{ name: 'Guanacaste', count: 8, coverThumbnailUrl: null }],
        cities: [],
      });

      render(<PlacesOverviewPage />);

      await waitFor(() => {
        expect(screen.getByText('Guanacaste')).toBeInTheDocument();
      });

      // Regions row is the only row with a populated "Show all" button in this scenario
      const showAllButtons = screen.getAllByRole('button', { name: /show all/i });
      fireEvent.click(showAllButtons[0]);

      expect(mockNavigate).toHaveBeenCalledWith('/places/regions');
    });

    it('navigates to /places/cities when the Cities "Show all" is clicked', async () => {
      mockGetExploreLocations.mockResolvedValue({
        countries: [],
        regions: [],
        cities: [{ name: 'Liberia', count: 4, coverThumbnailUrl: null }],
      });

      render(<PlacesOverviewPage />);

      await waitFor(() => {
        expect(screen.getByText('Liberia')).toBeInTheDocument();
      });

      const showAllButtons = screen.getAllByRole('button', { name: /show all/i });
      fireEvent.click(showAllButtons[0]);

      expect(mockNavigate).toHaveBeenCalledWith('/places/cities');
    });
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------
  describe('Loading state', () => {
    it('does not show row content while the service call is pending', () => {
      mockGetExploreLocations.mockReturnValue(new Promise(() => {}));

      render(<PlacesOverviewPage />);

      // Skeletons are shown; no location tiles yet since items are still []
      expect(screen.queryByRole('button', { name: /browse photos from/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------
  describe('Error handling', () => {
    it('shows an error alert when the service rejects', async () => {
      mockGetExploreLocations.mockRejectedValue(new Error('Network error'));

      render(<PlacesOverviewPage />);

      await waitFor(() => {
        const alert = screen.getByRole('alert');
        expect(alert.textContent).toMatch(/failed to load places/i);
      });
    });

    it('does not show location tiles after an error', async () => {
      mockGetExploreLocations.mockRejectedValue(new Error('fail'));

      render(<PlacesOverviewPage />);

      await waitFor(() => {
        expect(
          screen.queryByRole('button', { name: /browse photos from/i }),
        ).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Circle change
  // -------------------------------------------------------------------------
  describe('Circle change', () => {
    it('re-fetches locations when the active circle changes', async () => {
      const { rerender } = render(<PlacesOverviewPage />);

      await waitFor(() => expect(mockGetExploreLocations).toHaveBeenCalledTimes(1));

      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: { id: 'circle-2', name: 'Other Circle' },
        activeCircleId: 'circle-2',
      } as any);

      rerender(<PlacesOverviewPage />);

      await waitFor(() => expect(mockGetExploreLocations).toHaveBeenCalledTimes(2));
      expect(mockGetExploreLocations).toHaveBeenLastCalledWith('circle-2');
    });
  });
});

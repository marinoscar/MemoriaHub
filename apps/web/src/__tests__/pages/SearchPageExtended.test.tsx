/**
 * Extended coverage for SearchPage (topbar-search refactor).
 *
 * The new SearchPage is a passive results/explore view:
 *   - No conversational input (moved to TopbarSearch in AppBar).
 *   - Reads results/isSearching/error from SearchContext.
 *   - Navigates to explore carousels when idle.
 *
 * Tests cover: results branch, explore branch, clear, error, and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../contexts/SearchContext', () => ({
  useSearch: vi.fn(),
  SearchProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../hooks/usePeople', () => ({
  usePeople: vi.fn(),
}));

vi.mock('../../services/media', () => ({
  getExploreLocations: vi.fn().mockResolvedValue({
    countries: [{ name: 'Paris', countryCode: 'FR', count: 10, coverThumbnailUrl: null }],
    regions: [],
    cities: [],
  }),
  getExploreTags: vi.fn().mockResolvedValue([
    { name: 'beach', count: 5, coverThumbnailUrl: null },
  ]),
}));

vi.mock('../../components/media/MediaGallery', () => ({
  MediaGallery: vi.fn(() => <div data-testid="media-gallery" />),
}));

vi.mock('../../components/search/SearchPanel', () => ({
  SearchPanel: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import SearchPage from '../../pages/SearchPage';
import { useSearch } from '../../contexts/SearchContext';
import { useCircle } from '../../hooks/useCircle';
import { usePeople } from '../../hooks/usePeople';

const mockUseSearch = vi.mocked(useSearch);
const mockUseCircle = vi.mocked(useCircle);
const mockUsePeople = vi.mocked(usePeople);

// ---------------------------------------------------------------------------
// Default mock factories
// ---------------------------------------------------------------------------

function defaultSearchMock() {
  return {
    messages: [],
    results: null,
    isSearching: false,
    error: null,
    searchRequest: null,
    runAgentSearch: vi.fn(),
    runDeterministicSearch: vi.fn(),
    clearSearch: vi.fn(),
  };
}

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

function defaultPeopleMock() {
  return {
    data: { items: [], meta: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    cluster: vi.fn(),
    assignFaces: vi.fn(),
    unassignFace: vi.fn(),
  };
}

// Convenience factory: results state
function withResults(items = [], totalItems = 0) {
  return {
    ...defaultSearchMock(),
    results: {
      items,
      meta: { page: 1, pageSize: 20, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / 20)) },
    },
  };
}

// ---------------------------------------------------------------------------

describe('SearchPage — extended coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
    mockUseSearch.mockReturnValue(defaultSearchMock() as any);
    mockUsePeople.mockReturnValue(defaultPeopleMock() as any);
  });

  // -------------------------------------------------------------------------
  // Results / clear flow
  // -------------------------------------------------------------------------
  describe('Results and clear flow', () => {
    it('renders MediaGallery with results items', () => {
      mockUseSearch.mockReturnValue(withResults([], 7) as any);

      render(<SearchPage />);

      expect(screen.getByTestId('media-gallery')).toBeInTheDocument();
      expect(screen.getByText(/7 result/i)).toBeInTheDocument();
    });

    it('renders "1 result" (singular) when totalItems is 1', () => {
      mockUseSearch.mockReturnValue(withResults([], 1) as any);

      render(<SearchPage />);

      expect(screen.getByText('1 result')).toBeInTheDocument();
    });

    it('calls clearSearch when Clear is clicked', async () => {
      const clearSearch = vi.fn();
      mockUseSearch.mockReturnValue({ ...withResults(), clearSearch } as any);

      const user = userEvent.setup();
      render(<SearchPage />);

      await user.click(screen.getByRole('button', { name: /clear/i }));

      expect(clearSearch).toHaveBeenCalledOnce();
    });

    it('returns to explore view after clearSearch empties results', () => {
      // Simulate cleared state (results null, not searching)
      mockUseSearch.mockReturnValue(defaultSearchMock() as any);

      render(<SearchPage />);

      // Explore rows visible, no gallery
      expect(screen.getByText('Countries')).toBeInTheDocument();
      expect(screen.queryByTestId('media-gallery')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Searching state
  // -------------------------------------------------------------------------
  describe('Searching spinner', () => {
    it('shows spinner and "Searching…" while isSearching=true and results=null', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        isSearching: true,
        results: null,
      } as any);

      render(<SearchPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.getByText(/searching/i)).toBeInTheDocument();
    });

    it('shows Clear button even while searching (with null results)', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        isSearching: true,
        results: null,
      } as any);

      render(<SearchPage />);

      expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Explore section
  // -------------------------------------------------------------------------
  describe('Explore section', () => {
    it('shows Countries and Tags from explore endpoints', async () => {
      render(<SearchPage />);

      await waitFor(() => {
        expect(screen.getByText('Paris')).toBeInTheDocument();
        expect(screen.getByText('beach')).toBeInTheDocument();
      });
    });

    it('hides explore section when results are present', () => {
      mockUseSearch.mockReturnValue(withResults([], 3) as any);

      render(<SearchPage />);

      expect(screen.queryByText('Countries')).not.toBeInTheDocument();
      expect(screen.queryByText('Tags')).not.toBeInTheDocument();
    });

    it('hides explore section while isSearching is true', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        isSearching: true,
        results: null,
      } as any);

      render(<SearchPage />);

      // When searching (results view branch), explore rows should NOT be rendered.
      expect(screen.queryByText('Countries')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('Error display', () => {
    it('shows an error Alert when error is non-null', () => {
      mockUseSearch.mockReturnValue({
        ...withResults(),
        error: 'Search failed: timeout',
      } as any);

      render(<SearchPage />);

      expect(screen.getByText(/search failed: timeout/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // People explore row
  // -------------------------------------------------------------------------
  describe('People explore row', () => {
    it('shows the People section header and at least one person when people are available', () => {
      // Note: useFittedCount seeds from getBoundingClientRect().width which
      // returns 0 in jsdom, clamping count to 1. We therefore assert the
      // section header and the first visible person (Alice), not every item.
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            { id: 'p-1', name: 'Alice', isUnlabeled: false, faceCount: 3, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
            { id: 'p-2', name: 'Bob', isUnlabeled: false, faceCount: 2, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
        },
      } as any);

      render(<SearchPage />);

      // Section header must always be visible
      expect(screen.getByText('People')).toBeInTheDocument();
      // At least the first person tile renders
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    it('shows the "View all" button in the People section', () => {
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            { id: 'p-1', name: 'Alice', isUnlabeled: false, faceCount: 3, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
        },
      } as any);

      render(<SearchPage />);

      // The People ExploreCarousel sets viewAllLabel="View all" and onViewAll=navigate('/people')
      // At least one "View all" button should be present in the explore view
      const viewAllButtons = screen.getAllByRole('button', { name: /view all/i });
      expect(viewAllButtons.length).toBeGreaterThan(0);
    });

    it('does NOT show the People section when there are no labeled people', () => {
      // defaultPeopleMock returns no items — People section should not render
      render(<SearchPage />);

      expect(screen.queryByText('People')).not.toBeInTheDocument();
    });
  });
});

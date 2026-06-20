/**
 * Component tests — SearchPage (topbar-search refactor)
 *
 * After the refactor the SearchPage is a pure results/explore view:
 *   - No search input — input lives in TopbarSearch (AppBar).
 *   - Reads state from SearchContext via useSearch().
 *   - Shows MediaGallery when results !== null or isSearching.
 *   - Shows Explore (Places / Tags / People) carousels otherwise.
 *
 * Strategy: mock useSearch() and useCircle(); verify the two branches and
 * the Explore row behaviour.
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
  getExplorePlaces: vi.fn().mockResolvedValue([]),
  getExploreTags: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../components/media/MediaGallery', () => ({
  MediaGallery: vi.fn(() => <div data-testid="media-gallery" />),
}));

vi.mock('../../components/search/AdvancedSearchDialog', () => ({
  AdvancedSearchDialog: vi.fn(() => null),
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
    runAgentSearch: vi.fn(),
    runAdvancedResults: vi.fn(),
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

// ---------------------------------------------------------------------------

describe('SearchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
    mockUseSearch.mockReturnValue(defaultSearchMock() as any);
    mockUsePeople.mockReturnValue(defaultPeopleMock() as any);
  });

  // -------------------------------------------------------------------------
  // No active circle
  // -------------------------------------------------------------------------
  describe('No active circle', () => {
    it('renders an alert when activeCircle is null', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<SearchPage />);

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('alert').textContent).toMatch(/select a circle/i);
    });
  });

  // -------------------------------------------------------------------------
  // Explore view (default state — no results, no active search)
  // -------------------------------------------------------------------------
  describe('Explore rows', () => {
    it('shows Places and Tags explore row headers', () => {
      render(<SearchPage />);
      expect(screen.getByText('Places')).toBeInTheDocument();
      expect(screen.getByText('Tags')).toBeInTheDocument();
    });

    it('shows People section when people are available', () => {
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

      expect(screen.getByText('People')).toBeInTheDocument();
    });

    it('does NOT show the MediaGallery when results are null and not searching', () => {
      render(<SearchPage />);
      expect(screen.queryByTestId('media-gallery')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Results view (results in context)
  // -------------------------------------------------------------------------
  describe('Results view', () => {
    it('shows MediaGallery when results are present', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        results: {
          items: [],
          meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
        },
      } as any);

      render(<SearchPage />);

      expect(screen.getByTestId('media-gallery')).toBeInTheDocument();
    });

    it('hides explore rows when results are present', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        results: {
          items: [],
          meta: { page: 1, pageSize: 20, totalItems: 5, totalPages: 1 },
        },
      } as any);

      render(<SearchPage />);

      expect(screen.queryByText('Places')).not.toBeInTheDocument();
      expect(screen.queryByText('Tags')).not.toBeInTheDocument();
    });

    it('shows result count from meta.totalItems', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        results: {
          items: [],
          meta: { page: 1, pageSize: 20, totalItems: 42, totalPages: 3 },
        },
      } as any);

      render(<SearchPage />);

      expect(screen.getByText(/42 result/i)).toBeInTheDocument();
    });

    it('shows a Clear button when results are present', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        results: {
          items: [],
          meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
        },
      } as any);

      render(<SearchPage />);

      expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
    });

    it('calls clearSearch when the Clear button is clicked', async () => {
      const clearSearch = vi.fn();
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        clearSearch,
        results: {
          items: [],
          meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
        },
      } as any);

      const user = userEvent.setup();
      render(<SearchPage />);

      await user.click(screen.getByRole('button', { name: /clear/i }));

      expect(clearSearch).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Searching spinner (isSearching=true, results=null)
  // -------------------------------------------------------------------------
  describe('Searching state', () => {
    it('shows a spinner while isSearching is true and results are null', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        isSearching: true,
        results: null,
      } as any);

      render(<SearchPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows "Searching…" text while isSearching and results are null', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        isSearching: true,
        results: null,
      } as any);

      render(<SearchPage />);

      expect(screen.getByText(/searching/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------
  describe('Error state', () => {
    it('shows an error alert when the search context reports an error', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        error: 'Something went wrong',
        results: {
          items: [],
          meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
        },
      } as any);

      render(<SearchPage />);

      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Explore data loaded from service
  // -------------------------------------------------------------------------
  describe('Explore data', () => {
    it('shows Places from the explore endpoint', async () => {
      const { getExplorePlaces } = await import('../../services/media');
      vi.mocked(getExplorePlaces).mockResolvedValue([
        { name: 'Paris', count: 10, coverThumbnailUrl: null },
      ]);

      render(<SearchPage />);

      await waitFor(() => {
        expect(screen.getByText('Paris')).toBeInTheDocument();
      });
    });

    it('shows Tags from the explore endpoint', async () => {
      const { getExploreTags } = await import('../../services/media');
      vi.mocked(getExploreTags).mockResolvedValue([
        { name: 'beach', count: 5, coverThumbnailUrl: null },
      ]);

      render(<SearchPage />);

      await waitFor(() => {
        expect(screen.getByText('beach')).toBeInTheDocument();
      });
    });
  });
});

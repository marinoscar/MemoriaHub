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
  getExploreLocations: vi
    .fn()
    .mockResolvedValue({ countries: [], regions: [], cities: [] }),
  getExploreTags: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../components/media/MediaGallery', () => ({
  MediaGallery: vi.fn(() => <div data-testid="media-gallery" />),
}));

vi.mock('../../components/search/SearchPanel', () => ({
  SearchPanel: vi.fn(() => null),
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

// ---------------------------------------------------------------------------

describe('SearchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
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
    it('shows Countries, Regions, Cities, and Tags explore row headers', () => {
      render(<SearchPage />);
      expect(screen.getByText('Countries')).toBeInTheDocument();
      expect(screen.getByText('Regions')).toBeInTheDocument();
      expect(screen.getByText('Cities')).toBeInTheDocument();
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

    it('shows "See all places" button for the Countries section when countries are loaded', async () => {
      const { getExploreLocations } = await import('../../services/media');
      vi.mocked(getExploreLocations).mockResolvedValue({
        countries: [{ name: 'Rome', countryCode: 'IT', count: 4, coverThumbnailUrl: null }],
        regions: [],
        cities: [],
      });

      render(<SearchPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /see all places/i })).toBeInTheDocument();
      });
    });

    it('navigates to /places when "See all places" is clicked', async () => {
      const { getExploreLocations } = await import('../../services/media');
      vi.mocked(getExploreLocations).mockResolvedValue({
        countries: [{ name: 'Rome', countryCode: 'IT', count: 4, coverThumbnailUrl: null }],
        regions: [],
        cities: [],
      });

      const user = userEvent.setup();
      render(<SearchPage />);

      const seeAllButton = await screen.findByRole('button', { name: /see all places/i });
      await user.click(seeAllButton);

      expect(mockNavigate).toHaveBeenCalledWith('/places');
    });

    it('shows "View all" button for the Tags section when tags are loaded', async () => {
      const { getExploreTags } = await import('../../services/media');
      vi.mocked(getExploreTags).mockResolvedValue([
        { name: 'sunset', count: 7, coverThumbnailUrl: null },
      ]);

      render(<SearchPage />);

      await waitFor(() => {
        // Multiple "View all" buttons may exist (Places + Tags); assert at least one
        const buttons = screen.getAllByRole('button', { name: /view all/i });
        expect(buttons.length).toBeGreaterThan(0);
      });
    });

    it('shows "View all" button for People section when people are loaded', () => {
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            { id: 'p-1', name: 'Alice', isUnlabeled: false, faceCount: 5, coverFace: null, createdAt: '', updatedAt: '', favorite: true },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
        },
      } as any);

      render(<SearchPage />);

      const viewAllButtons = screen.getAllByRole('button', { name: /view all/i });
      expect(viewAllButtons.length).toBeGreaterThan(0);
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

      expect(screen.queryByText('Countries')).not.toBeInTheDocument();
      expect(screen.queryByText('Regions')).not.toBeInTheDocument();
      expect(screen.queryByText('Cities')).not.toBeInTheDocument();
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
    it('shows Countries from the explore endpoint', async () => {
      const { getExploreLocations } = await import('../../services/media');
      vi.mocked(getExploreLocations).mockResolvedValue({
        countries: [{ name: 'Paris', countryCode: 'FR', count: 10, coverThumbnailUrl: null }],
        regions: [],
        cities: [],
      });

      render(<SearchPage />);

      await waitFor(() => {
        expect(screen.getByText('Paris')).toBeInTheDocument();
      });
    });

    it('shows Regions from the explore endpoint', async () => {
      const { getExploreLocations } = await import('../../services/media');
      vi.mocked(getExploreLocations).mockResolvedValue({
        countries: [],
        regions: [{ name: 'Provence', count: 6, coverThumbnailUrl: null }],
        cities: [],
      });

      render(<SearchPage />);

      await waitFor(() => {
        expect(screen.getByText('Provence')).toBeInTheDocument();
      });
    });

    it('shows Cities from the explore endpoint', async () => {
      const { getExploreLocations } = await import('../../services/media');
      vi.mocked(getExploreLocations).mockResolvedValue({
        countries: [],
        regions: [],
        cities: [{ name: 'Nice', count: 3, coverThumbnailUrl: null }],
      });

      render(<SearchPage />);

      await waitFor(() => {
        expect(screen.getByText('Nice')).toBeInTheDocument();
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

  // -------------------------------------------------------------------------
  // People sort: favorites-first, then faceCount descending
  // -------------------------------------------------------------------------
  describe('People sort order', () => {
    it('renders the favorite person before a non-favorite when count allows 1 tile', () => {
      // jsdom: getBoundingClientRect returns 0 → useFittedCount clamps to 1.
      // The person that appears must be the one that sorts first: favorite first.
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            // Carol is non-favorite with many faces — should sort AFTER Dave
            { id: 'p-carol', name: 'Carol', isUnlabeled: false, faceCount: 50, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
            // Dave is a favorite with fewer faces — sorts FIRST
            { id: 'p-dave', name: 'Dave', isUnlabeled: false, faceCount: 3, coverFace: null, createdAt: '', updatedAt: '', favorite: true },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
        },
      } as any);

      render(<SearchPage />);

      // Dave (favorite=true) must appear since it's the first item after sort
      expect(screen.getByText('Dave')).toBeInTheDocument();
      // Carol should not appear because jsdom caps the carousel at 1 tile
      expect(screen.queryByText('Carol')).not.toBeInTheDocument();
    });

    it('renders the person with the highest faceCount first when no favorites', () => {
      // Non-favorite items are sorted by faceCount desc; 1 tile visible in jsdom.
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            // Eve has fewer faces — sorts second
            { id: 'p-eve', name: 'Eve', isUnlabeled: false, faceCount: 2, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
            // Frank has more faces — sorts first
            { id: 'p-frank', name: 'Frank', isUnlabeled: false, faceCount: 10, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
        },
      } as any);

      render(<SearchPage />);

      // Frank (higher faceCount) must be visible
      expect(screen.getByText('Frank')).toBeInTheDocument();
      // Eve should not appear because jsdom caps the carousel at 1 tile
      expect(screen.queryByText('Eve')).not.toBeInTheDocument();
    });

    it('excludes unlabeled (null-name) people from the People row', () => {
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            { id: 'p-unlabeled', name: null, isUnlabeled: true, faceCount: 8, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
            { id: 'p-named', name: 'Grace', isUnlabeled: false, faceCount: 1, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
        },
      } as any);

      render(<SearchPage />);

      // Grace should be visible; the unnamed person has no text to check
      expect(screen.getByText('Grace')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Capability guard — regression coverage for production bug #400.
  //
  // #392 gated TopbarSearch (the AppBar's search pill) to `md`+, on the
  // rationale that Search moved to a bottom-bar destination. But `/search`
  // had no input of its own, so below 900px there was NO way to run a
  // search or open SearchPanel at all — every #392 test still passed
  // because they all asserted CHROME ("TopbarSearch hidden below md"), never
  // CAPABILITY ("can a user actually search from this page"). These tests
  // assert capability directly, in every SearchPage branch, with no AppBar
  // mounted — so they fail the way #400 failed if PageSearchBarSection is
  // ever removed from a branch again.
  // -------------------------------------------------------------------------
  describe('Capability guard — search remains usable in every branch (regression for #400)', () => {
    // None of these tests render AppBar/TopbarSearch — `render()` from
    // test-utils mounts SearchPage bare, exactly like every test above. That
    // is deliberate: the whole bug was the page silently depending on
    // toolbar chrome it does not itself render, so proving the guard here
    // must not accidentally lean on chrome either.
    it('sanity check: this suite never mounts AppBar / TopbarSearch', () => {
      render(<SearchPage />);
      // TopbarSearch's own aria-label ("Open advanced search filters") is
      // distinct from PageSearchBar's ("Advanced search") specifically so
      // this assertion cannot be satisfied by the toolbar accidentally
      // being present.
      expect(
        screen.queryByRole('button', { name: /open advanced search filters/i }),
      ).not.toBeInTheDocument();
    });

    it('branch: no active circle — a search input and advanced-search trigger are present (disabled)', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<SearchPage />);

      // Confirms we are really in the no-circle branch.
      expect(screen.getByRole('alert').textContent).toMatch(/select a circle/i);

      expect(screen.getByRole('textbox', { name: /search your photos/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /advanced search/i })).toBeInTheDocument();
    });

    it('branch: deterministic (advanced) results (searchRequest !== null) — search input and advanced trigger are present', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        searchRequest: { circleId: 'circle-1', filters: {} },
      } as any);

      render(<SearchPage />);

      // Confirms we are really in the deterministic-results branch, and that
      // the fix is additive — the gallery still renders alongside the bar.
      expect(screen.getByTestId('media-gallery')).toBeInTheDocument();
      expect(screen.getByText(/search results/i)).toBeInTheDocument();

      expect(screen.getByRole('textbox', { name: /search your photos/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /advanced search/i })).toBeInTheDocument();
    });

    it('branch: agentic results (results !== null) — search input and advanced trigger are present', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        results: {
          items: [],
          meta: { page: 1, pageSize: 20, totalItems: 3, totalPages: 1 },
        },
      } as any);

      render(<SearchPage />);

      // Confirms we are really in the agentic-results branch, and that
      // existing content (the gallery, the result count) is undisturbed.
      expect(screen.getByTestId('media-gallery')).toBeInTheDocument();
      expect(screen.getByText(/3 results/i)).toBeInTheDocument();

      expect(screen.getByRole('textbox', { name: /search your photos/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /advanced search/i })).toBeInTheDocument();
    });

    it('branch: agentic search in flight (isSearching, results === null) — search input and advanced trigger are present', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        isSearching: true,
        results: null,
      } as any);

      render(<SearchPage />);

      // Confirms we are really in the isSearching branch.
      expect(screen.getByRole('progressbar')).toBeInTheDocument();

      expect(screen.getByRole('textbox', { name: /search your photos/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /advanced search/i })).toBeInTheDocument();
    });

    it('branch: default explore state (no request, no results, not searching) — search input and advanced trigger are present', () => {
      // defaultSearchMock() is already searchRequest:null, results:null,
      // isSearching:false — the explore branch.
      render(<SearchPage />);

      // Confirms we are really in the explore branch, and existing content
      // (the Explore carousels) is undisturbed.
      expect(screen.getByText('Countries')).toBeInTheDocument();
      expect(screen.getByText('Regions')).toBeInTheDocument();
      expect(screen.getByText('Cities')).toBeInTheDocument();
      expect(screen.getByText('Tags')).toBeInTheDocument();

      expect(screen.getByRole('textbox', { name: /search your photos/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /advanced search/i })).toBeInTheDocument();
    });

    it('typing into the page search bar in the explore branch actually reaches runAgentSearch (end-to-end, not just presence)', async () => {
      const runAgentSearch = vi.fn();
      mockUseSearch.mockReturnValue({ ...defaultSearchMock(), runAgentSearch } as any);

      const user = userEvent.setup();
      render(<SearchPage />);

      const input = screen.getByRole('textbox', { name: /search your photos/i });
      await user.type(input, 'birthday party{Enter}');

      expect(runAgentSearch).toHaveBeenCalledWith('birthday party');
    });
  });
});

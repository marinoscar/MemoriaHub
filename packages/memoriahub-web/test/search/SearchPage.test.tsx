/**
 * Component tests — SearchPage (topbar-search refactor)
 *
 * After the refactor the SearchPage is a pure results/explore view:
 *   - No search input — input lives in TopbarSearch (AppBar).
 *   - Reads state from SearchContext via useSearch().
 *   - Shows MediaGallery when results !== null or isSearching.
 *   - Shows Explore (Places / Tags carousels, and the host's people slot) otherwise.
 *
 * Strategy: mock useSearch() and useOwnerScope(); verify the two branches and
 * the Explore row behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/search/ui/contexts/SearchContext.js', () => ({
  useSearch: vi.fn(),
  SearchProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../src/core/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOwnerScope: vi.fn(),
}));

vi.mock('../../src/media/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getExploreLocations: vi
    .fn()
    .mockResolvedValue({ countries: [], regions: [], cities: [] }),
  getExploreTags: vi.fn().mockResolvedValue([]),

}));

vi.mock('../../src/media/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MediaGallery: vi.fn(() => <div data-testid="media-gallery" />),

}));

// The people carousel is the people slice's; a stub keeps the test free of async calls.
vi.mock('../../src/people/ui/index.js', () => ({
  SearchPeopleExplore: ({ circleId }: { circleId: string }) => <div data-testid="people-slot">{circleId}</div>,
}));

vi.mock('../../src/search/ui/components/SearchPanel.js', () => ({
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

import { SearchPage } from '../../src/search/ui/pages/SearchPage.js';
import { useSearch } from '../../src/search/ui/contexts/SearchContext.js';
import { useOwnerScope } from '../../src/core/headless/index.js';

const mockUseSearch = vi.mocked(useSearch);
const mockUseOwnerScope = vi.mocked(useOwnerScope);

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

// ---------------------------------------------------------------------------

describe('SearchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    mockUseOwnerScope.mockReturnValue(defaultCircleMock() as any);
    mockUseSearch.mockReturnValue(defaultSearchMock() as any);
  });

  // -------------------------------------------------------------------------
  // No active circle
  // -------------------------------------------------------------------------
  describe('No active circle', () => {
    it('renders an alert when activeCircle is null', () => {
      mockUseOwnerScope.mockReturnValue({
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



    it('renders the people carousel with the active circle in the explore view', () => {
      render(<SearchPage />);
      expect(screen.getByTestId('people-slot')).toHaveTextContent('circle-1');
    });

    it('does NOT show the MediaGallery when results are null and not searching', () => {
      render(<SearchPage />);
      expect(screen.queryByTestId('media-gallery')).not.toBeInTheDocument();
    });

    it('shows "See all places" button for the Countries section when countries are loaded', async () => {
      const { getExploreLocations } = await import('../../src/media/headless/index.js');
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
      const { getExploreLocations } = await import('../../src/media/headless/index.js');
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
      const { getExploreTags } = await import('../../src/media/headless/index.js');
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
      const { getExploreLocations } = await import('../../src/media/headless/index.js');
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
      const { getExploreLocations } = await import('../../src/media/headless/index.js');
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
      const { getExploreLocations } = await import('../../src/media/headless/index.js');
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
      const { getExploreTags } = await import('../../src/media/headless/index.js');
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
      mockUseOwnerScope.mockReturnValue({
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

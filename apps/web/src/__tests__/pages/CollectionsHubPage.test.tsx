/**
 * Tests for CollectionsHubPage (issue #391, spec §3.1 / §4.6 / §6.1).
 *
 * Mocks the SERVICE layer (services/media, services/face, services/memories)
 * rather than `useCollectionSummaries`, mirroring `CollectionsList.test.tsx` /
 * `ReviewHubPage.test.tsx` — this page renders the real hook, so each case
 * can drive genuine async resolution timing (the whole point of the
 * "renders before covers resolve" case below).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { render } from '../utils/test-utils';
import CollectionsHubPage from '../../pages/Collections/CollectionsHubPage';
import type { Album, AlbumListResponse } from '../../types/media';
import type { PersonListResponse } from '../../services/face';
import type { ExploreLocations } from '../../services/media';
import type { MemoryListResponse } from '../../types/memories';

vi.mock('../../services/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/media')>()),
  listAlbums: vi.fn(),
  getExploreLocations: vi.fn(),
}));
vi.mock('../../services/face', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/face')>()),
  listPeople: vi.fn(),
}));
vi.mock('../../services/memories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/memories')>()),
  listMemories: vi.fn(),
}));
vi.mock('../../hooks/useMemoriesEnabled', () => ({
  useMemoriesEnabled: vi.fn(),
}));
vi.mock('../../hooks/useScrollRestoration', () => ({
  useScrollRestoration: vi.fn(),
}));

import { listAlbums, getExploreLocations } from '../../services/media';
import { listPeople } from '../../services/face';
import { listMemories } from '../../services/memories';
import { useMemoriesEnabled } from '../../hooks/useMemoriesEnabled';

const mockListAlbums = vi.mocked(listAlbums);
const mockListPeople = vi.mocked(listPeople);
const mockGetExploreLocations = vi.mocked(getExploreLocations);
const mockListMemories = vi.mocked(listMemories);
const mockUseMemoriesEnabled = vi.mocked(useMemoriesEnabled);

// ---------------------------------------------------------------------------
// Viewport helper — same technique as AppBar.test.tsx: compute `matches` from
// the actual min-width embedded in MUI's compiled breakpoint query string, so
// `useMediaQuery(theme.breakpoints.up('lg'))` responds to a single px value.
// ---------------------------------------------------------------------------

function setViewportWidth(px: number) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const min = query.match(/min-width:\s*([\d.]+)px/);
      const max = query.match(/max-width:\s*([\d.]+)px/);
      let matches = true;
      if (min) matches = matches && px >= parseFloat(min[1]);
      if (max) matches = matches && px <= parseFloat(max[1]);
      return {
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

function restoreDefaultViewport() {
  // Matches setup.ts's baseline: every query reports `matches: false`, i.e.
  // "not desktop" — the phone/tablet default every other test relies on.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function album(overrides: Partial<Album> = {}): Album {
  return {
    id: 'album-1',
    name: 'Album',
    description: null,
    addedById: 'user-1',
    circleId: 'circle-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    coverThumbnailUrl: 'https://x/album-cover.jpg',
    ...overrides,
  };
}

function albumsResponse(overrides: Partial<AlbumListResponse> = {}): AlbumListResponse {
  return {
    items: [album()],
    meta: { page: 1, pageSize: 4, totalItems: 24, totalPages: 6 },
    ...overrides,
  };
}

function peopleResponse(overrides: Partial<PersonListResponse> = {}): PersonListResponse {
  return {
    items: [],
    meta: { page: 1, pageSize: 4, totalItems: 5, totalPages: 2 },
    ...overrides,
  };
}

function placesResponse(overrides: Partial<ExploreLocations> = {}): ExploreLocations {
  return {
    countries: [],
    regions: [],
    cities: [{ name: 'Heredia', countryCode: 'CR', count: 3, coverThumbnailUrl: null }],
    ...overrides,
  };
}

function memoriesResponse(overrides: Partial<MemoryListResponse> = {}): MemoryListResponse {
  return {
    items: [],
    meta: { pageSize: 50, nextCursor: null, hasMore: false },
    ...overrides,
  };
}

describe('CollectionsHubPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreDefaultViewport();
    mockUseMemoriesEnabled.mockReturnValue(true);
    mockListAlbums.mockResolvedValue(albumsResponse());
    mockListPeople.mockResolvedValue(peopleResponse());
    mockGetExploreLocations.mockResolvedValue(placesResponse());
    mockListMemories.mockResolvedValue(memoriesResponse());
  });

  afterEach(() => {
    restoreDefaultViewport();
  });

  // =========================================================================
  // Phone / tablet render the card grid
  // =========================================================================

  it('renders the card grid heading and all five primary cards on phone (default viewport)', async () => {
    render(<CollectionsHubPage />);

    expect(screen.getByRole('heading', { name: 'Collections' })).toBeInTheDocument();
    for (const label of ['Albums', 'People', 'Places', 'Memories', 'Map']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const label of ['Favorites', 'Archive', 'Trash']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('renders the same card grid on tablet width', async () => {
    setViewportWidth(950); // md-lg range: >= md (900), < lg (1200)

    render(<CollectionsHubPage />);

    expect(screen.getByRole('heading', { name: 'Collections' })).toBeInTheDocument();
    expect(screen.getByText('Albums')).toBeInTheDocument();
  });

  // =========================================================================
  // Desktop: NO grid, redirect to /albums
  // =========================================================================

  it('desktop (up("lg")) renders no grid and redirects to /albums', async () => {
    setViewportWidth(1300);

    function Harness() {
      return (
        <Routes>
          <Route path="/collections" element={<CollectionsHubPage />} />
          <Route path="/albums" element={<div>Albums Page Marker</div>} />
        </Routes>
      );
    }

    render(<Harness />, { wrapperOptions: { route: '/collections' } });

    // Redirected — the marker for the destination route is on screen.
    expect(await screen.findByText('Albums Page Marker')).toBeInTheDocument();

    // The hub's own chrome never rendered.
    expect(screen.queryByRole('heading', { name: 'Collections' })).not.toBeInTheDocument();
    expect(screen.queryByText('Favorites')).not.toBeInTheDocument();
  });

  // =========================================================================
  // Performance contract (spec §6.1) — the most valuable case in this file:
  // the layout is on screen before ANY of the four sources resolve, and there
  // is no full-page spinner.
  // =========================================================================

  it('renders card labels immediately, with no full-page spinner, while all four sources are still pending', () => {
    // Every source hangs forever — this is the harshest version of "still
    // loading" a real network condition can produce.
    mockListAlbums.mockReturnValue(new Promise<AlbumListResponse>(() => {}));
    mockListPeople.mockReturnValue(new Promise<PersonListResponse>(() => {}));
    mockGetExploreLocations.mockReturnValue(new Promise<ExploreLocations>(() => {}));
    mockListMemories.mockReturnValue(new Promise<MemoryListResponse>(() => {}));

    const { container } = render(<CollectionsHubPage />);

    // The heading and every card label are already on screen — no gate on
    // the network resolving.
    expect(screen.getByRole('heading', { name: 'Collections' })).toBeInTheDocument();
    for (const label of ['Albums', 'People', 'Places', 'Memories', 'Map']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    // No full-page spinner anywhere — covers render as skeletons in place,
    // never as a blocking loading state for the whole page.
    expect(container.querySelector('.MuiCircularProgress-root')).toBeNull();

    // The skeleton placeholders ARE present — proof the covers are rendering
    // their loading treatment in place, not simply omitted.
    expect(container.querySelectorAll('.MuiSkeleton-root').length).toBeGreaterThan(0);
  });

  // =========================================================================
  // One failed source degrades only its own card
  // =========================================================================

  it('a failed source degrades only its own card; the others still show their counts', async () => {
    mockListPeople.mockRejectedValue(new Error('people endpoint down'));

    render(<CollectionsHubPage />);

    // The other cards still resolve to their real counts.
    const albumsLink = await screen.findByRole('link', { name: 'Albums, 24 items' });
    expect(albumsLink).toBeInTheDocument();

    // The People card degrades: no count phrase in its accessible name, and
    // no numeral rendered — while the label itself still renders (its icon
    // fallback, not a blank hole).
    const peopleLink = await screen.findByRole('link', { name: 'People' });
    expect(peopleLink).toBeInTheDocument();
    expect(within(peopleLink).queryByText(/^\d+\+?$/)).not.toBeInTheDocument();
    // Its own icon fallback is present (an svg inside the card).
    expect(peopleLink.querySelector('svg')).not.toBeNull();
  });

  // =========================================================================
  // Cards are real links with an aria-label including the count
  // =========================================================================

  it('a primary card is a real link with an aria-label that includes the count', async () => {
    render(<CollectionsHubPage />);

    const albumsLink = await screen.findByRole('link', { name: 'Albums, 24 items' });
    expect(albumsLink).toHaveAttribute('href', '/albums');

    const memoriesLink = await screen.findByRole('link', { name: /Memories/ });
    expect(memoriesLink).toHaveAttribute('href', '/memories');
  });

  it('a secondary (icon-only) link carries just its label as the accessible name', async () => {
    render(<CollectionsHubPage />);

    const favoritesLink = await screen.findByRole('link', { name: 'Favorites' });
    expect(favoritesLink).toHaveAttribute('href', '/media?favorite=1');
  });

  // =========================================================================
  // Grid columns respond to breakpoint
  //
  // The column COUNT (`xs: repeat(2,...)`, `md: repeat(3,...)`) is expressed
  // entirely through MUI `sx` breakpoints, which compile to real CSS `@media`
  // rules inside an emotion-injected stylesheet. jsdom does not evaluate CSS
  // media queries at all (there is no viewport-driven cascade), so there is no
  // way to observe from the rendered DOM which column count is "in effect" at
  // a given `window` width — asserting a specific `gridTemplateColumns` value
  // here would not be exercising the breakpoint at all, just reading whatever
  // jsdom's non-conditional stylesheet parsing happens to expose, which is not
  // meaningfully different from a hardcoded string. That is not assertable in
  // this environment, so it is not asserted.
  //
  // What IS genuinely assertable, and would fail if a future change hid a
  // card at one breakpoint but not another: the same five primary cards
  // render at both a phone width and a tablet width.
  // =========================================================================

  it('the same five primary cards render at both phone and tablet widths (content parity across breakpoints)', () => {
    setViewportWidth(400); // phone
    const phoneRender = render(<CollectionsHubPage />);
    const phoneLabels = ['Albums', 'People', 'Places', 'Memories', 'Map'].map((label) =>
      Boolean(within(phoneRender.container).queryByText(label)),
    );
    phoneRender.unmount();

    setViewportWidth(950); // tablet
    const tabletRender = render(<CollectionsHubPage />);
    const tabletLabels = ['Albums', 'People', 'Places', 'Memories', 'Map'].map((label) =>
      Boolean(within(tabletRender.container).queryByText(label)),
    );

    expect(phoneLabels).toEqual([true, true, true, true, true]);
    expect(tabletLabels).toEqual([true, true, true, true, true]);
  });
});

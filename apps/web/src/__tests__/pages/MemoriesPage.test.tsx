/**
 * Component tests — MemoriesPage, the `/memories` hub (epic #300, issue #309).
 *
 * Three things are worth protecting here and they are all failure modes rather
 * than happy paths:
 *
 *  1. Feature gating — flag off means no request AND no grid, with a route that
 *     still resolves so a bookmark does not 404.
 *  2. Action-menu PERMISSIONS — Delete is omitted (not disabled) for a viewer,
 *     because a disabled destructive item advertises a capability the API would
 *     refuse anyway.
 *  3. The delete confirm — the dialog has to state that the tombstone is
 *     permanent and circle-wide, and offer per-user hide as the soft option.
 *     That copy IS the safety mechanism, so it is asserted literally.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser, mockAdminUser } from '../utils/test-utils';
import type { MemoryCard } from '../../types/memories';

vi.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(),
}));

vi.mock('../../services/memories', () => ({
  listMemories: vi.fn(),
  markMemorySeen: vi.fn(),
  hideMemory: vi.fn(),
  unhideMemory: vi.fn(),
  favoriteMemory: vi.fn(),
  unfavoriteMemory: vi.fn(),
  deleteMemory: vi.fn(),
  saveMemoryAsAlbum: vi.fn(),
}));

import MemoriesPage from '../../pages/Memories/MemoriesPage';
import { useFeatureFlags } from '../../hooks/useFeatureFlags';
import {
  deleteMemory,
  favoriteMemory,
  hideMemory,
  listMemories,
} from '../../services/memories';

const mockFlags = vi.mocked(useFeatureFlags);
const mockList = vi.mocked(listMemories);
const mockDelete = vi.mocked(deleteMemory);
const mockHide = vi.mocked(hideMemory);
const mockFavorite = vi.mocked(favoriteMemory);

function setFlags(features: Record<string, boolean> | null, isLoading = false) {
  mockFlags.mockReturnValue({
    features,
    pictureEnhancement: null,
    isLoading,
    error: null,
    refresh: vi.fn(),
  });
}

function makeCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  return {
    id: 'mem-1',
    type: 'trip',
    title: 'Trip to Guanacaste',
    subtitle: 'March 2023',
    itemCount: 24,
    periodStart: '2023-03-12T00:00:00.000Z',
    periodEnd: '2023-03-18T00:00:00.000Z',
    coverMediaItemId: 'media-1',
    coverThumbnailUrl: 'https://cdn/cover.jpg',
    meta: null,
    myState: { seen: false, favorited: false },
    generatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function page(items: MemoryCard[]) {
  return { items, meta: { pageSize: 24, nextCursor: null, hasMore: false } };
}

interface RenderOpts {
  route?: string;
  user?: typeof mockUser;
  activeCircleRole?: 'viewer' | 'collaborator' | 'circle_admin';
}

function renderPage({
  route = '/memories',
  user = mockUser,
  activeCircleRole = 'collaborator',
}: RenderOpts = {}) {
  return render(<MemoriesPage />, {
    wrapperOptions: { authenticated: true, user, route, activeCircleRole },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setFlags({ memories: true });
  mockList.mockResolvedValue(page([makeCard()]));
  mockDelete.mockResolvedValue(undefined);
  mockHide.mockResolvedValue(undefined);
  mockFavorite.mockResolvedValue(undefined);
});

describe('MemoriesPage — feature gating', () => {
  it('explains the feature is off and fires no request when the flag is off', async () => {
    setFlags({ memories: false });

    renderPage();

    expect(await screen.findByText(/memories are turned off/i)).toBeInTheDocument();
    expect(mockList).not.toHaveBeenCalled();
    expect(screen.queryByTestId('memory-card')).not.toBeInTheDocument();
  });

  it('fires no request while the flags are still loading', () => {
    setFlags(null, true);

    renderPage();

    expect(mockList).not.toHaveBeenCalled();
  });

  it('shows skeletons — not the empty state — while the flags load', () => {
    setFlags(null, true);

    renderPage();

    // The list hook is disabled until the flag resolves, so `items` is empty
    // for a reason that is NOT "this circle has no memories". Rendering the
    // new-install copy here would flash a wrong answer before the first
    // request has even been allowed to fire.
    expect(
      screen.queryByText(/your memories will appear here/i),
    ).not.toBeInTheDocument();
    expect(screen.getAllByTestId('memory-card-skeleton').length).toBeGreaterThan(0);
  });

  it('points an admin at the settings page when the feature is off', async () => {
    setFlags({ memories: false });

    renderPage({ user: mockAdminUser });

    const link = await screen.findByRole('link', { name: /memories settings/i });
    expect(link).toHaveAttribute('href', '/admin/settings/memories');
  });

  it('does not offer the settings link to a non-admin', async () => {
    setFlags({ memories: false });

    renderPage();

    await screen.findByText(/memories are turned off/i);
    expect(
      screen.queryByRole('link', { name: /memories settings/i }),
    ).not.toBeInTheDocument();
  });
});

describe('MemoriesPage — listing', () => {
  it('lists memories for the active circle under a month header', async () => {
    renderPage();

    expect(await screen.findByTestId('memory-card')).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ circleId: 'circle-1' }),
    );
    // `generatedAt` is 2026-08-01, so the group header is that month.
    expect(screen.getByText(/august 2026/i)).toBeInTheDocument();
  });

  it('reads filters out of the URL and sends them to the API', async () => {
    renderPage({ route: '/memories?type=seasonal&year=2025&favorite=true' });

    await waitFor(() =>
      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'seasonal', year: 2025, favorite: true }),
      ),
    );
  });

  it('ignores an unrecognised type in the URL rather than sending it on', async () => {
    renderPage({ route: '/memories?type=not-a-type' });

    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ type: undefined }),
    );
  });

  it('ignores an out-of-range year in the URL', async () => {
    renderPage({ route: '/memories?year=99999' });

    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ year: undefined }));
  });

  it('shows the new-install empty state when the circle has no memories', async () => {
    mockList.mockResolvedValue(page([]));

    renderPage();

    expect(
      await screen.findByText(/your memories will appear here/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/curates them automatically as your library grows/i),
    ).toBeInTheDocument();
  });

  it('gates the admin backfill hint on the admin role', async () => {
    mockList.mockResolvedValue(page([]));

    renderPage();
    await screen.findByText(/your memories will appear here/i);
    expect(screen.queryByRole('link', { name: /run a backfill/i })).not.toBeInTheDocument();
  });

  it('offers the admin backfill hint to an admin', async () => {
    mockList.mockResolvedValue(page([]));

    renderPage({ user: mockAdminUser });

    expect(
      await screen.findByRole('link', { name: /run a backfill/i }),
    ).toBeInTheDocument();
  });

  it('uses the filtered-empty copy when a type filter is active', async () => {
    mockList.mockResolvedValue(page([]));

    renderPage({ route: '/memories?type=trip' });

    expect(await screen.findByText(/no trip memories yet/i)).toBeInTheDocument();
  });
});

describe('MemoriesPage — action menu permissions', () => {
  it('omits Delete for a viewer', async () => {
    const user = userEvent.setup();
    renderPage({ activeCircleRole: 'viewer' });

    await screen.findByTestId('memory-card');
    await user.click(screen.getByRole('button', { name: /actions for/i }));

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /hide for me/i })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('offers Delete to a collaborator', async () => {
    const user = userEvent.setup();
    renderPage({ activeCircleRole: 'collaborator' });

    await screen.findByTestId('memory-card');
    await user.click(screen.getByRole('button', { name: /actions for/i }));

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /^delete$/i })).toBeInTheDocument();
  });
});

describe('MemoriesPage — actions', () => {
  it('favorites optimistically from the menu', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('memory-card');
    await user.click(screen.getByRole('button', { name: /actions for/i }));
    await user.click(await screen.findByRole('menuitem', { name: /^favorite$/i }));

    await waitFor(() => expect(mockFavorite).toHaveBeenCalledWith('mem-1'));
  });

  it('hides a memory and removes its card', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('memory-card');
    await user.click(screen.getByRole('button', { name: /actions for/i }));
    await user.click(await screen.findByRole('menuitem', { name: /hide for me/i }));

    await waitFor(() => expect(mockHide).toHaveBeenCalledWith('mem-1'));
    await waitFor(() =>
      expect(screen.queryByTestId('memory-card')).not.toBeInTheDocument(),
    );
  });

  it('states the permanence and offers hide before deleting for everyone', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('memory-card');
    await user.click(screen.getByRole('button', { name: /actions for/i }));
    await user.click(await screen.findByRole('menuitem', { name: /^delete$/i }));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/delete this memory for everyone/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/won’t be created again/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/can’t be undone/i)).toBeInTheDocument();
    // The reversible alternative is offered right in the confirm.
    expect(
      within(dialog).getByRole('button', { name: /hide for me/i }),
    ).toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('deletes only after the confirm is accepted', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('memory-card');
    await user.click(screen.getByRole('button', { name: /actions for/i }));
    await user.click(await screen.findByRole('menuitem', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: /delete for everyone/i }),
    );

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('mem-1'));
  });

  it('cancels without deleting', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('memory-card');
    await user.click(screen.getByRole('button', { name: /actions for/i }));
    await user.click(await screen.findByRole('menuitem', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('restores the card when a delete is refused by the API', async () => {
    mockDelete.mockRejectedValue(new Error('Forbidden'));
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('memory-card');
    await user.click(screen.getByRole('button', { name: /actions for/i }));
    await user.click(await screen.findByRole('menuitem', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: /delete for everyone/i }),
    );

    await waitFor(() => expect(screen.getByText('Forbidden')).toBeInTheDocument());
    // The optimistic removal is rolled back, so the card is back on the page.
    expect(screen.getByTestId('memory-card')).toBeInTheDocument();
  });
});

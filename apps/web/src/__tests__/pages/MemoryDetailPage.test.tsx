/**
 * Component tests — MemoryDetailPage (epic #300, issues #309 + #313).
 *
 * This page is the SINGLE mount point for the story player, so the two things
 * asserted here are the seams every other surface depends on:
 *
 *   1. Play opens the player, and `?play=1` opens it on arrival — that is what
 *      makes playback deep-linkable from the carousel, the notification and the
 *      digest email without any of them mounting a player of their own.
 *   2. The `play` flag is consumed ONCE and stripped, so closing the story and
 *      pressing Back does not immediately relaunch it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { render, mockUser } from '../utils/test-utils';
import type { MemoryDetail } from '../../types/memories';

vi.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(),
}));

vi.mock('../../services/memories', () => ({
  getMemory: vi.fn(),
  markMemorySeen: vi.fn(),
  hideMemory: vi.fn(),
  unhideMemory: vi.fn(),
  favoriteMemory: vi.fn(),
  unfavoriteMemory: vi.fn(),
  deleteMemory: vi.fn(),
  saveMemoryAsAlbum: vi.fn(),
}));

vi.mock('../../services/media', () => ({
  getMedia: vi.fn(),
}));

import MemoryDetailPage from '../../pages/Memories/MemoryDetailPage';
import { useFeatureFlags } from '../../hooks/useFeatureFlags';
import {
  getMemory,
  markMemorySeen,
  saveMemoryAsAlbum,
} from '../../services/memories';
import { getMedia } from '../../services/media';
import { resetSeenSession } from '../../hooks/useMemoryActions';

const mockFlags = vi.mocked(useFeatureFlags);
const mockGetMemory = vi.mocked(getMemory);
const mockSaveAlbum = vi.mocked(saveMemoryAsAlbum);
const mockGetMedia = vi.mocked(getMedia);
const mockMarkSeen = vi.mocked(markMemorySeen);

function setFlags(memories: boolean) {
  mockFlags.mockReturnValue({
    features: { memories },
    pictureEnhancement: null,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  });
}

function makeMemory(overrides: Partial<MemoryDetail> = {}): MemoryDetail {
  return {
    id: 'mem-1',
    circleId: 'circle-1',
    type: 'trip',
    title: 'Trip to Guanacaste',
    subtitle: 'March 2023',
    narrative: null,
    titleSource: 'template',
    titleModel: null,
    personId: null,
    itemCount: 2,
    periodStart: '2023-03-12T00:00:00.000Z',
    periodEnd: '2023-03-18T00:00:00.000Z',
    coverMediaItemId: 'media-1',
    coverThumbnailUrl: 'https://cdn/cover.jpg',
    meta: null,
    myState: { seen: false, favorited: false, hidden: false },
    generatedAt: '2026-08-01T00:00:00.000Z',
    refreshedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: null,
    items: [
      {
        id: 'item-1',
        mediaItemId: 'media-1',
        position: 0,
        mediaType: 'image/jpeg',
        width: 4000,
        height: 3000,
        durationMs: null,
        capturedAt: '2023-03-12T15:04:00.000Z',
        thumbnailUrl: 'https://cdn/thumb-1.jpg',
      },
      {
        id: 'item-2',
        mediaItemId: 'media-2',
        position: 1,
        mediaType: 'image/jpeg',
        width: 4000,
        height: 3000,
        durationMs: null,
        capturedAt: '2023-03-13T15:04:00.000Z',
        thumbnailUrl: 'https://cdn/thumb-2.jpg',
      },
    ],
    ...overrides,
  };
}

function renderPage(route = '/memories/mem-1') {
  return render(
    <Routes>
      <Route path="/memories/:id" element={<MemoryDetailPage />} />
    </Routes>,
    { wrapperOptions: { authenticated: true, user: mockUser, route, activeCircleRole: 'collaborator' } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSeenSession();
  setFlags(true);
  mockGetMemory.mockResolvedValue(makeMemory());
  mockSaveAlbum.mockResolvedValue({ albumId: 'album-9' });
  // `useMemoryActions.markSeen` chains `.catch` onto this call, so a bare
  // `vi.fn()` returning undefined would throw the moment the player opens.
  mockMarkSeen.mockResolvedValue(undefined);
  mockGetMedia.mockResolvedValue({
    id: 'media-1',
    downloadUrl: 'https://cdn/full.jpg',
    type: 'photo',
  } as never);
});

describe('MemoryDetailPage — story player entry', () => {
  it('opens the player from the Play button', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'Trip to Guanacaste' });
    expect(screen.queryByTestId('memory-story-player')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Play' }));

    expect(await screen.findByTestId('memory-story-player')).toBeInTheDocument();
    expect(screen.getByTestId('story-title-card')).toBeInTheDocument();
  });

  it('auto-opens the player on a `?play=1` deep link', async () => {
    renderPage('/memories/mem-1?play=1');

    expect(await screen.findByTestId('memory-story-player')).toBeInTheDocument();
  });

  it('closing the story leaves the user on the detail grid', async () => {
    const user = userEvent.setup();
    renderPage('/memories/mem-1?play=1');

    await screen.findByTestId('memory-story-player');
    await user.click(screen.getByRole('button', { name: 'Close story' }));

    await waitFor(() =>
      expect(screen.queryByTestId('memory-story-player')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Trip to Guanacaste' })).toBeInTheDocument();
  });

  it('disables Play for a memory whose items have all gone', async () => {
    mockGetMemory.mockResolvedValue(makeMemory({ items: [], itemCount: 0 }));
    renderPage();

    await screen.findByRole('heading', { name: 'Trip to Guanacaste' });
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
  });
});

describe('MemoryDetailPage — save as album and share', () => {
  it('opens the naming dialog prefilled with the memory title', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'Trip to Guanacaste' });
    await user.click(screen.getByRole('button', { name: 'Save as album' }));

    const field = (await screen.findByLabelText('Album name')) as HTMLInputElement;
    expect(field.value).toBe('Trip to Guanacaste');
    // Nothing is created until the user confirms.
    expect(mockSaveAlbum).not.toHaveBeenCalled();
  });

  it('shares by creating an album first, then handing off to the share flow', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'Trip to Guanacaste' });
    await user.click(screen.getByRole('button', { name: 'Share memory' }));

    await waitFor(() =>
      expect(mockSaveAlbum).toHaveBeenCalledWith('mem-1', 'Trip to Guanacaste'),
    );
    expect(await screen.findByText('Share publicly')).toBeInTheDocument();
  });
});

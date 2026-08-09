/**
 * Component tests — MemoryStoryPlayer (epic #300, issue #313).
 *
 * The three things worth protecting here are the ones a future refactor is
 * most likely to break silently:
 *
 *   1. THE CLOCK. The title card holds 2.5s, a photo 5s, a video its own
 *      length capped at 15s, and the end card never advances on its own. This
 *      is asserted with fake timers rather than by staring at it.
 *   2. PAUSE ARITHMETIC. Pausing must BANK the unspent remainder, not restart
 *      the slide — a resumed 5s photo that had 1s left must advance after 1s.
 *   3. REDUCED MOTION. Ken Burns and the crossfade must disappear, and the
 *      player must keep working — the failure mode to avoid is a player that
 *      silently stops advancing when motion is suppressed, which is exactly
 *      what happens if the advance is ever driven off `animationend`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { render, mockUser } from '../../utils/test-utils';
import type { MemoryDetail, MemoryDetailItem } from '../../../types/memories';

vi.mock('../../../services/media', () => ({
  getMedia: vi.fn(),
}));

import {
  MemoryStoryPlayer,
  resetStoryMediaCache,
} from '../../../components/memories/MemoryStoryPlayer';
import {
  PHOTO_DURATION_MS,
  TITLE_CARD_DURATION_MS,
} from '../../../components/memories/storyTiming';
import { getMedia } from '../../../services/media';

const mockGetMedia = vi.mocked(getMedia);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(index: number, overrides: Partial<MemoryDetailItem> = {}): MemoryDetailItem {
  return {
    id: `item-${index}`,
    mediaItemId: `media-${index}`,
    position: index,
    mediaType: 'image/jpeg',
    width: 4000,
    height: 3000,
    durationMs: null,
    capturedAt: '2023-03-12T15:04:00.000Z',
    thumbnailUrl: `https://cdn/thumb-${index}.jpg`,
    ...overrides,
  };
}

function makeMemory(items: MemoryDetailItem[]): MemoryDetail {
  return {
    id: 'mem-1',
    circleId: 'circle-1',
    type: 'trip',
    title: 'Trip to Guanacaste',
    subtitle: 'March 2023',
    narrative: 'Six days of sunburn and pipas.',
    titleSource: 'ai',
    titleModel: 'claude',
    personId: null,
    itemCount: items.length,
    periodStart: '2023-03-12T00:00:00.000Z',
    periodEnd: '2023-03-18T00:00:00.000Z',
    coverMediaItemId: 'media-0',
    coverThumbnailUrl: 'https://cdn/cover.jpg',
    meta: null,
    myState: { seen: false, favorited: false, hidden: false },
    generatedAt: '2026-08-01T00:00:00.000Z',
    refreshedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: null,
    items,
  };
}

/** Force `prefers-reduced-motion: reduce` to match for this test only. */
function setReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderPlayer(
  memory: MemoryDetail,
  props: Partial<React.ComponentProps<typeof MemoryStoryPlayer>> = {},
) {
  return render(
    <MemoryStoryPlayer memory={memory} open onClose={vi.fn()} {...props} />,
    { wrapperOptions: { authenticated: true, user: mockUser } },
  );
}

/**
 * Advance BOTH the fake clock and React's effect queue.
 *
 * Split into 250ms ticks on purpose: a slide's timer is only SCHEDULED by the
 * effect that runs after the previous slide's advance commits, so one
 * `advanceTimersByTime(7500)` would fire the title card's timer and then stop —
 * the photo's timer does not exist yet at the moment the clock jumps. Ticking
 * lets each newly-scheduled timer participate, which is how the real clock
 * behaves.
 */
async function advance(ms: number) {
  const STEP = 250;
  for (let elapsed = 0; elapsed < ms; elapsed += STEP) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      vi.advanceTimersByTime(Math.min(STEP, ms - elapsed));
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStoryMediaCache();
  setReducedMotion(false);
  // `getMedia` never resolving would leave every slide on its thumbnail, which
  // is a legitimate state but not the one most of these tests are about.
  mockGetMedia.mockImplementation((id: string) =>
    Promise.resolve({
      id,
      downloadUrl: `https://cdn/full-${id}.jpg`,
      type: 'photo',
      geoLocality: 'Tamarindo',
      // The player only reads these four fields.
    } as never),
  );
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('MemoryStoryPlayer — the clock', () => {
  it('opens on the title card and advances to the first slide after 2.5s', async () => {
    renderPlayer(makeMemory([makeItem(0), makeItem(1)]));

    expect(screen.getByTestId('story-title-card')).toBeInTheDocument();
    expect(screen.getByText('Trip to Guanacaste')).toBeInTheDocument();
    expect(screen.getByText('Six days of sunburn and pipas.')).toBeInTheDocument();

    await advance(TITLE_CARD_DURATION_MS - 100);
    expect(screen.getByTestId('story-title-card')).toBeInTheDocument();

    await advance(200);
    expect(screen.queryByTestId('story-title-card')).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  });

  it('holds each photo for five seconds and then reaches the end card', async () => {
    renderPlayer(makeMemory([makeItem(0), makeItem(1)]));

    await advance(TITLE_CARD_DURATION_MS);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');

    await advance(PHOTO_DURATION_MS);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');

    await advance(PHOTO_DURATION_MS);
    expect(screen.getByTestId('story-end-card')).toBeInTheDocument();
  });

  it('never auto-advances off the end card', async () => {
    const onClose = vi.fn();
    renderPlayer(makeMemory([makeItem(0)]), { onClose });

    await advance(TITLE_CARD_DURATION_MS + PHOTO_DURATION_MS);
    expect(screen.getByTestId('story-end-card')).toBeInTheDocument();

    await advance(60_000);
    expect(screen.getByTestId('story-end-card')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('marks the memory seen exactly once, on open', async () => {
    const onSeen = vi.fn();
    renderPlayer(makeMemory([makeItem(0), makeItem(1)]), { onSeen });

    expect(onSeen).toHaveBeenCalledTimes(1);
    expect(onSeen).toHaveBeenCalledWith('mem-1');

    await advance(TITLE_CARD_DURATION_MS + PHOTO_DURATION_MS);
    expect(onSeen).toHaveBeenCalledTimes(1);
  });
});

describe('MemoryStoryPlayer — pause', () => {
  it('banks the unspent remainder rather than restarting the slide', async () => {
    renderPlayer(makeMemory([makeItem(0), makeItem(1)]));
    await advance(TITLE_CARD_DURATION_MS);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');

    // 4 of the photo's 5 seconds are spent, then the story is paused.
    await advance(4_000);
    await act(async () => {
      screen.getByRole('button', { name: 'Pause story' }).click();
    });

    // Time passes while paused; the slide must not move.
    await advance(30_000);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');

    await act(async () => {
      screen.getByRole('button', { name: 'Play story' }).click();
    });

    // Only the banked 1s remains — not a fresh 5.
    await advance(900);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    await advance(200);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  });

  it('pauses while the owner has a dialog open over the player', async () => {
    const { rerender } = renderPlayer(makeMemory([makeItem(0), makeItem(1)]));
    await advance(TITLE_CARD_DURATION_MS);

    rerender(
      <MemoryStoryPlayer
        memory={makeMemory([makeItem(0), makeItem(1)])}
        open
        onClose={vi.fn()}
        suspended
      />,
    );

    await advance(30_000);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  });
});

describe('MemoryStoryPlayer — keyboard', () => {
  it('navigates with the arrow keys and toggles pause with space', async () => {
    renderPlayer(makeMemory([makeItem(0), makeItem(1), makeItem(2)]));
    await advance(TITLE_CARD_DURATION_MS);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(screen.getByRole('button', { name: 'Play story' })).toBeInTheDocument();
    await advance(30_000);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(screen.getByRole('button', { name: 'Pause story' })).toBeInTheDocument();
  });

  it('jumps to the end card with End and back to the title with Home', async () => {
    renderPlayer(makeMemory([makeItem(0), makeItem(1), makeItem(2)]));

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(screen.getByTestId('story-end-card')).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(screen.getByTestId('story-title-card')).toBeInTheDocument();
  });

  it('leaves space alone when a control has focus, so buttons still activate', async () => {
    renderPlayer(makeMemory([makeItem(0), makeItem(1)]));
    await advance(TITLE_CARD_DURATION_MS);

    const pause = screen.getByRole('button', { name: 'Pause story' });
    await act(async () => {
      pause.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });

    // The window handler must NOT have toggled: only the button's own default
    // activation may act on Space, or a focused button would double-fire.
    expect(screen.getByRole('button', { name: 'Pause story' })).toBeInTheDocument();
  });
});

describe('MemoryStoryPlayer — accessibility', () => {
  it('exposes the story as one labelled progressbar, not a dozen meters', async () => {
    renderPlayer(makeMemory([makeItem(0), makeItem(1), makeItem(2)]));
    await advance(TITLE_CARD_DURATION_MS);

    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveAttribute('aria-valuemax', '3');
    expect(bars[0]).toHaveAttribute('aria-valuetext', 'Slide 1 of 3');
  });

  it('announces the position politely on every slide change', async () => {
    renderPlayer(makeMemory([makeItem(0), makeItem(1)]));

    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('Trip to Guanacaste');

    await advance(TITLE_CARD_DURATION_MS);
    expect(screen.getByRole('status')).toHaveTextContent('Photo 1 of 2');
  });

  it('labels the dialog and every control', async () => {
    renderPlayer(makeMemory([makeItem(0)]));

    expect(screen.getByRole('dialog')).toHaveAttribute(
      'aria-label',
      'Trip to Guanacaste — memory story',
    );
    expect(screen.getByRole('button', { name: 'Close story' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause story' })).toBeInTheDocument();
  });
});

describe('MemoryStoryPlayer — reduced motion', () => {
  it('drops Ken Burns and the crossfade but keeps advancing', async () => {
    setReducedMotion(true);
    renderPlayer(makeMemory([makeItem(0), makeItem(1)]));

    await advance(TITLE_CARD_DURATION_MS);

    const slides = screen.getAllByTestId('story-slide');
    const current = slides.find((el) => el.dataset.current === 'true');
    expect(current).toBeDefined();
    // The crossfade is a transition on the slide layer; under reduced motion
    // slides cut instead.
    expect(current!.style.transition === '' || current!.style.transition === 'none').toBe(
      true,
    );

    const image = current!.querySelector('img:not([aria-hidden])') as HTMLElement | null;
    expect(image?.style.animation ?? '').not.toContain('ken-burns');

    // The whole point: the story still runs.
    await advance(PHOTO_DURATION_MS);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  });
});

describe('MemoryStoryPlayer — media resolution', () => {
  it('resolves the current slide and preloads the next two, no further', async () => {
    renderPlayer(
      makeMemory([makeItem(0), makeItem(1), makeItem(2), makeItem(3), makeItem(4)]),
    );
    await advance(TITLE_CARD_DURATION_MS);

    await waitFor(() => {
      expect(mockGetMedia).toHaveBeenCalledWith('media-0');
    });
    expect(mockGetMedia).toHaveBeenCalledWith('media-1');
    expect(mockGetMedia).toHaveBeenCalledWith('media-2');
    expect(mockGetMedia).not.toHaveBeenCalledWith('media-4');
  });

  it('keeps the thumbnail visible when the full media never resolves', async () => {
    mockGetMedia.mockRejectedValue(new Error('offline'));
    renderPlayer(makeMemory([makeItem(0), makeItem(1)]));
    await advance(TITLE_CARD_DURATION_MS);

    const current = screen
      .getAllByTestId('story-slide')
      .find((el) => el.dataset.current === 'true');
    const image = current!.querySelector('img:not([aria-hidden])') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('https://cdn/thumb-0.jpg');

    // A failed fetch must not stall the story.
    await advance(PHOTO_DURATION_MS);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  });
});

describe('MemoryStoryPlayer — end card', () => {
  it('offers all five actions and wires each one', async () => {
    const onToggleFavorite = vi.fn();
    const onSaveAsAlbum = vi.fn();
    const onShare = vi.fn();
    const onViewAllPhotos = vi.fn();

    renderPlayer(makeMemory([makeItem(0)]), {
      onToggleFavorite,
      onSaveAsAlbum,
      onShare,
      onViewAllPhotos,
    });
    await advance(TITLE_CARD_DURATION_MS + PHOTO_DURATION_MS);

    await act(async () => {
      screen.getByRole('button', { name: /favorite/i }).click();
    });
    expect(onToggleFavorite).toHaveBeenCalledWith(true);

    await act(async () => {
      screen.getByRole('button', { name: /save as album/i }).click();
    });
    expect(onSaveAsAlbum).toHaveBeenCalled();

    await act(async () => {
      screen.getByRole('button', { name: /share/i }).click();
    });
    expect(onShare).toHaveBeenCalled();

    await act(async () => {
      screen.getByRole('button', { name: /view all photos/i }).click();
    });
    expect(onViewAllPhotos).toHaveBeenCalled();
  });

  it('replays from the title card', async () => {
    renderPlayer(makeMemory([makeItem(0)]));
    await advance(TITLE_CARD_DURATION_MS + PHOTO_DURATION_MS);
    expect(screen.getByTestId('story-end-card')).toBeInTheDocument();

    await act(async () => {
      screen.getByRole('button', { name: /replay/i }).click();
    });
    expect(screen.getByTestId('story-title-card')).toBeInTheDocument();
  });
});

describe('MemoryStoryPlayer — closed', () => {
  it('renders nothing and fires no request while closed', () => {
    render(
      <MemoryStoryPlayer memory={makeMemory([makeItem(0)])} open={false} onClose={vi.fn()} />,
      { wrapperOptions: { authenticated: true, user: mockUser } },
    );

    expect(screen.queryByTestId('memory-story-player')).not.toBeInTheDocument();
    expect(mockGetMedia).not.toHaveBeenCalled();
  });
});

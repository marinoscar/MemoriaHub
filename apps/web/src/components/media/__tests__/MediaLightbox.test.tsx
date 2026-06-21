/**
 * Component tests — MediaLightbox
 *
 * Mocking strategy:
 *   - `services/media` is module-mocked so `getMedia` and `patchMedia` never
 *     hit the network.
 *   - `VideoPlayer` is replaced with a lightweight stub so Vidstack (which
 *     requires a real DOM media element) never loads in jsdom.
 *   - The module-scope `fullItemCache` inside MediaLightbox is bypassed by
 *     resetting mocks between tests — each test controls what `getMedia` resolves
 *     to, and the cache is populated by the component's own effect.
 *
 * Test organisation:
 *   1. Open / closed state
 *   2. Image loading (thumbnail placeholder then full-res)
 *   3. Close — button click and Escape key
 *   4. Navigation — chevron buttons and arrow keys, clamped at boundaries
 *   5. Properties panel — Info button
 *   6. Video item — video player rendered instead of <img>
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../__tests__/utils/test-utils';
import { MediaLightbox } from '../MediaLightbox';
import type { MediaItem } from '../../../types/media';

// ---------------------------------------------------------------------------
// Module mocks — declared before any import of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../../services/media', () => ({
  getMedia: vi.fn(),
  patchMedia: vi.fn(),
  // Other exports used by unrelated pages — include stubs so the module resolves
  listTags: vi.fn(),
  initUpload: vi.fn(),
  uploadPart: vi.fn(),
  completeUpload: vi.fn(),
  registerMedia: vi.fn(),
  listAlbums: vi.fn(),
  exportMedia: vi.fn(),
}));

// Stub out VideoPlayer — Vidstack pulls in heavy DOM internals that break jsdom.
vi.mock('../VideoPlayer', () => ({
  VideoPlayer: ({ src, title }: { src: string; title?: string }) => (
    <video data-testid="video-player" src={src} aria-label={title ?? 'Video'} />
  ),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { getMedia, patchMedia } from '../../../services/media';

const mockGetMedia = vi.mocked(getMedia);
const mockPatchMedia = vi.mocked(patchMedia);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMediaItem(id: string, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    storageObjectId: `storage-${id}`,
    addedById: 'user-001',
    circleId: 'circle-1',
    type: 'photo',
    capturedAt: '2024-06-15T10:30:00.000Z',
    capturedAtOffset: null,
    importedAt: null,
    source: 'web',
    contentHash: null,
    width: 1920,
    height: 1080,
    durationMs: null,
    orientation: null,
    takenLat: null,
    takenLng: null,
    takenAltitude: null,
    cameraMake: null,
    cameraModel: null,
    originalFilename: `file-${id}.jpg`,
    description: null,
    favorite: false,
    geoCountry: null,
    geoCountryCode: null,
    geoAdmin1: null,
    geoAdmin2: null,
    geoLocality: null,
    geoPlaceName: null,
    geoSource: null,
    geocodedAt: null,
    createdAt: '2024-06-15T10:30:00.000Z',
    updatedAt: '2024-06-15T10:30:00.000Z',
    deletedAt: null,
    metadata: null,
    thumbnailUrl: `https://cdn.example.com/thumb-${id}.jpg`,
    downloadUrl: null,
    ...overrides,
  };
}

/** A full item as returned by GET /api/media/:id (includes downloadUrl). */
function makeFullItem(base: MediaItem): MediaItem {
  return {
    ...base,
    downloadUrl: `https://cdn.example.com/full-${base.id}.jpg`,
  };
}

// ---------------------------------------------------------------------------
// Default props helpers
// ---------------------------------------------------------------------------

interface LightboxProps {
  items?: MediaItem[];
  index?: number | null;
  onIndexChange?: ReturnType<typeof vi.fn>;
  onClose?: ReturnType<typeof vi.fn>;
  onOpenProperties?: ReturnType<typeof vi.fn>;
  onItemUpdated?: ReturnType<typeof vi.fn>;
}

function renderLightbox(props: LightboxProps = {}) {
  const items = props.items ?? [makeMediaItem('img-1')];
  const onIndexChange = props.onIndexChange ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  const onOpenProperties = props.onOpenProperties ?? vi.fn();

  return render(
    <MediaLightbox
      items={items}
      index={props.index !== undefined ? props.index : 0}
      onIndexChange={onIndexChange}
      onClose={onClose}
      onOpenProperties={onOpenProperties}
      onItemUpdated={props.onItemUpdated}
    />,
  );
}

// ---------------------------------------------------------------------------
// beforeEach — clear all mocks between tests so cache doesn't leak
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: getMedia resolves with a full item that has a downloadUrl.
  // Individual tests override this where needed.
  mockGetMedia.mockImplementation(async (id: string) =>
    makeFullItem(makeMediaItem(id)),
  );
  mockPatchMedia.mockResolvedValue(makeMediaItem('img-1'));
});

// ---------------------------------------------------------------------------
// 1. Open / closed state
// ---------------------------------------------------------------------------

describe('open / closed state', () => {
  it('renders a full-screen Dialog when index is a valid number', () => {
    renderLightbox({ index: 0 });
    // The close button is only present when the lightbox is open
    expect(
      screen.getByRole('button', { name: /close lightbox/i }),
    ).toBeInTheDocument();
  });

  it('renders a closed Dialog (not interactive) when index is null', () => {
    renderLightbox({ index: null });
    expect(
      screen.queryByRole('button', { name: /close lightbox/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the originalFilename in the header bar', () => {
    const item = makeMediaItem('x1', { originalFilename: 'Sunset at the Beach.jpg' });
    renderLightbox({ items: [item], index: 0 });
    expect(screen.getByText('Sunset at the Beach.jpg')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. Image loading — thumbnail first, then full-res
// ---------------------------------------------------------------------------

describe('image loading', () => {
  it('shows the thumbnail placeholder immediately', () => {
    // getMedia is a pending promise on first call — thumbnail must appear now
    let resolveGetMedia!: (v: MediaItem) => void;
    mockGetMedia.mockImplementation(
      () =>
        new Promise<MediaItem>((res) => {
          resolveGetMedia = res;
        }),
    );

    const item = makeMediaItem('img-2', {
      thumbnailUrl: 'https://cdn.example.com/thumb-img-2.jpg',
    });
    renderLightbox({ items: [item], index: 0 });

    // The blurred placeholder img renders with the thumbnail URL
    const thumbImgs = screen.getAllByRole('img');
    const thumbImg = thumbImgs.find(
      (el) =>
        (el as HTMLImageElement).src === 'https://cdn.example.com/thumb-img-2.jpg',
    );
    expect(thumbImg).toBeDefined();

    // Cleanup: resolve the hanging promise
    resolveGetMedia(makeFullItem(item));
  });

  it('shows the full-res image after getMedia resolves', async () => {
    const item = makeMediaItem('img-3', {
      thumbnailUrl: 'https://cdn.example.com/thumb-img-3.jpg',
    });
    const fullItem = makeFullItem(item);
    mockGetMedia.mockResolvedValue(fullItem);

    renderLightbox({ items: [item], index: 0 });

    await waitFor(() => {
      const imgs = screen.getAllByRole('img');
      const fullImg = imgs.find(
        (el) =>
          (el as HTMLImageElement).src === fullItem.downloadUrl,
      );
      expect(fullImg).toBeDefined();
    });
  });

  it('calls getMedia with the current item id', async () => {
    const item = makeMediaItem('item-fetch-test');
    renderLightbox({ items: [item], index: 0 });

    await waitFor(() => {
      expect(mockGetMedia).toHaveBeenCalledWith('item-fetch-test');
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Close — button and Escape key
// ---------------------------------------------------------------------------

describe('close behaviour', () => {
  it('calls onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderLightbox({ onClose });

    await user.click(screen.getByRole('button', { name: /close lightbox/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the Escape key is pressed', () => {
    const onClose = vi.fn();
    renderLightbox({ onClose });

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose for Escape when index is null', () => {
    const onClose = vi.fn();
    renderLightbox({ onClose, index: null });

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Navigation — chevrons and arrow keys
// ---------------------------------------------------------------------------

describe('navigation', () => {
  const threeItems = [
    makeMediaItem('nav-1'),
    makeMediaItem('nav-2'),
    makeMediaItem('nav-3'),
  ];

  it('calls onIndexChange with index+1 when the Next chevron is clicked', async () => {
    const onIndexChange = vi.fn();
    const user = userEvent.setup();
    renderLightbox({ items: threeItems, index: 1, onIndexChange });

    await user.click(screen.getByRole('button', { name: /next photo/i }));

    expect(onIndexChange).toHaveBeenCalledWith(2);
  });

  it('calls onIndexChange with index-1 when the Prev chevron is clicked', async () => {
    const onIndexChange = vi.fn();
    const user = userEvent.setup();
    renderLightbox({ items: threeItems, index: 1, onIndexChange });

    await user.click(screen.getByRole('button', { name: /previous photo/i }));

    expect(onIndexChange).toHaveBeenCalledWith(0);
  });

  it('calls onIndexChange with index+1 on ArrowRight key', () => {
    const onIndexChange = vi.fn();
    renderLightbox({ items: threeItems, index: 0, onIndexChange });

    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it('calls onIndexChange with index-1 on ArrowLeft key', () => {
    const onIndexChange = vi.fn();
    renderLightbox({ items: threeItems, index: 2, onIndexChange });

    fireEvent.keyDown(window, { key: 'ArrowLeft' });

    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it('Prev chevron is disabled at the first item (index 0)', () => {
    renderLightbox({ items: threeItems, index: 0 });

    const prevBtn = screen.getByRole('button', { name: /previous photo/i });
    expect(prevBtn).toBeDisabled();
  });

  it('Next chevron is disabled at the last item', () => {
    renderLightbox({ items: threeItems, index: 2 });

    const nextBtn = screen.getByRole('button', { name: /next photo/i });
    expect(nextBtn).toBeDisabled();
  });

  it('does not call onIndexChange on ArrowLeft when at index 0', () => {
    const onIndexChange = vi.fn();
    renderLightbox({ items: threeItems, index: 0, onIndexChange });

    fireEvent.keyDown(window, { key: 'ArrowLeft' });

    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('does not call onIndexChange on ArrowRight when at the last item', () => {
    const onIndexChange = vi.fn();
    renderLightbox({ items: threeItems, index: 2, onIndexChange });

    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect(onIndexChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Properties panel — Info button
// ---------------------------------------------------------------------------

describe('properties panel', () => {
  it('calls onOpenProperties with the current item when Info button is clicked', async () => {
    const onOpenProperties = vi.fn();
    const user = userEvent.setup();
    const item = makeMediaItem('props-item');
    renderLightbox({ items: [item], index: 0, onOpenProperties });

    await user.click(screen.getByRole('button', { name: /open properties panel/i }));

    expect(onOpenProperties).toHaveBeenCalledTimes(1);
    // First argument should be the displayed item (thumbnail or full)
    const calledWith: MediaItem = onOpenProperties.mock.calls[0][0];
    expect(calledWith.id).toBe('props-item');
  });

  it('calls onOpenProperties with the full item once getMedia has resolved', async () => {
    const onOpenProperties = vi.fn();
    const user = userEvent.setup();
    const item = makeMediaItem('props-full');
    const fullItem = makeFullItem(item);
    mockGetMedia.mockResolvedValue(fullItem);

    renderLightbox({ items: [item], index: 0, onOpenProperties });

    // Wait for the effect to resolve
    await waitFor(() => {
      expect(mockGetMedia).toHaveBeenCalledWith('props-full');
    });

    await user.click(screen.getByRole('button', { name: /open properties panel/i }));

    const calledWith: MediaItem = onOpenProperties.mock.calls[0][0];
    expect(calledWith.downloadUrl).toBe(fullItem.downloadUrl);
  });
});

// ---------------------------------------------------------------------------
// 6. Video item
// ---------------------------------------------------------------------------

describe('video item', () => {
  it('shows a spinner while the download URL is being fetched', () => {
    // Keep getMedia pending so downloadUrl is never set
    mockGetMedia.mockImplementation(
      () => new Promise<MediaItem>(() => {}), // never resolves
    );

    const videoItem = makeMediaItem('vid-1', {
      type: 'video',
      thumbnailUrl: 'https://cdn.example.com/poster-vid-1.jpg',
      downloadUrl: null,
    });
    renderLightbox({ items: [videoItem], index: 0 });

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByTestId('video-player')).not.toBeInTheDocument();
  });

  it('renders the VideoPlayer once the download URL is available', async () => {
    const videoItem = makeMediaItem('vid-2', {
      type: 'video',
      thumbnailUrl: 'https://cdn.example.com/poster-vid-2.jpg',
      downloadUrl: null,
    });
    const fullVideoItem: MediaItem = {
      ...videoItem,
      downloadUrl: 'https://cdn.example.com/full-vid-2.mp4',
    };
    mockGetMedia.mockResolvedValue(fullVideoItem);

    renderLightbox({ items: [videoItem], index: 0 });

    await waitFor(() => {
      expect(screen.getByTestId('video-player')).toBeInTheDocument();
    });

    const player = screen.getByTestId('video-player') as HTMLVideoElement;
    expect(player.src).toBe('https://cdn.example.com/full-vid-2.mp4');
  });

  it('does not render a photo <img> element for a video item', async () => {
    const videoItem = makeMediaItem('vid-3', {
      type: 'video',
      thumbnailUrl: 'https://cdn.example.com/poster-vid-3.jpg',
      downloadUrl: null,
    });
    const fullVideoItem: MediaItem = {
      ...videoItem,
      downloadUrl: 'https://cdn.example.com/full-vid-3.mp4',
    };
    mockGetMedia.mockResolvedValue(fullVideoItem);

    renderLightbox({ items: [videoItem], index: 0 });

    await waitFor(() => {
      expect(screen.getByTestId('video-player')).toBeInTheDocument();
    });

    // The full-res img element (used for photos) should NOT appear for a video
    const imgs = screen.queryAllByRole('img');
    const fullResImg = imgs.find(
      (el) =>
        (el as HTMLImageElement).src === 'https://cdn.example.com/full-vid-3.mp4',
    );
    expect(fullResImg).toBeUndefined();
  });
});

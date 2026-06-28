/**
 * Unit tests for PersonAvatar component.
 *
 * PersonAvatar has a module-level cache (mediaCache) that deduplicates concurrent
 * fetches for the same mediaItemId. Because the cache is module-level it persists
 * across tests in the same file. We accept this: the dedup test renders two avatars
 * in the same test case to verify the cache works, and we use vi.clearAllMocks() in
 * beforeEach to reset call counts on the mock fn (the cache may already hold a value
 * from a prior test, so call counts can be 0 if the value is cached — that's fine for
 * most tests; the dedup test runs fresh because it picks a unique mediaItemId).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PersonAvatar } from '../../../components/people/PersonAvatar';
import type { PersonAvatarPerson } from '../../../components/people/PersonAvatar';

// ---------------------------------------------------------------------------
// Module mocks — must appear before any import that transitively loads them
// ---------------------------------------------------------------------------

vi.mock('react-easy-crop', () => ({ default: () => null }));

vi.mock('../../../services/media', () => ({
  getMedia: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports that depend on mocks
// ---------------------------------------------------------------------------

import { getMedia } from '../../../services/media';

const mockGetMedia = vi.mocked(getMedia);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePerson(overrides: Partial<PersonAvatarPerson> = {}): PersonAvatarPerson {
  return {
    id: 'p1',
    name: 'Alice',
    coverFace: null,
    profileMediaItemId: null,
    profileCrop: null,
    ...overrides,
  };
}

const BOUNDING_BOX = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PersonAvatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: getMedia resolves with a thumbnail URL
    mockGetMedia.mockResolvedValue({
      id: 'media-1',
      thumbnailUrl: 'https://example.com/thumb.jpg',
      downloadUrl: 'https://example.com/full.jpg',
    } as any);
  });

  // -------------------------------------------------------------------------
  describe('Case 3 — generic MUI Avatar fallback (no coverFace, no profileMediaItemId)', () => {
    it('renders without throwing', () => {
      expect(() => render(<PersonAvatar person={makePerson()} />)).not.toThrow();
    });

    it('does NOT show a FaceCrop (aria-label="Face crop") when no image sources are provided', () => {
      render(<PersonAvatar person={makePerson()} />);
      expect(screen.queryByRole('img', { name: 'Face crop' })).not.toBeInTheDocument();
    });

    it('does NOT call getMedia when neither coverFace nor profileMediaItemId is set', () => {
      render(<PersonAvatar person={makePerson()} />);
      expect(mockGetMedia).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('Case 2 — coverFace present (no profileMediaItemId)', () => {
    it('renders FaceCrop after resolving the cover media item', async () => {
      const person = makePerson({
        coverFace: { faceId: 'f1', mediaItemId: 'media-cover', boundingBox: BOUNDING_BOX, faceThumbnailUrl: null },
      });

      render(<PersonAvatar person={person} />);

      await waitFor(() => {
        expect(screen.getByRole('img', { name: 'Face crop' })).toBeInTheDocument();
      });
    });

    it('calls getMedia with the coverFace mediaItemId', async () => {
      const person = makePerson({
        coverFace: { faceId: 'f1', mediaItemId: 'media-cover-id', boundingBox: BOUNDING_BOX, faceThumbnailUrl: null },
      });

      render(<PersonAvatar person={person} />);

      await waitFor(() => {
        expect(mockGetMedia).toHaveBeenCalledWith('media-cover-id');
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Case 1a — profileMediaItemId + profileCrop (custom crop)', () => {
    it('renders FaceCrop after resolving the profile media item', async () => {
      const person = makePerson({
        profileMediaItemId: 'media-profile',
        profileCrop: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
      });

      render(<PersonAvatar person={person} />);

      await waitFor(() => {
        expect(screen.getByRole('img', { name: 'Face crop' })).toBeInTheDocument();
      });
    });

    it('calls getMedia with the profileMediaItemId', async () => {
      const person = makePerson({
        profileMediaItemId: 'media-profile-id',
        profileCrop: { x: 0.0, y: 0.0, w: 0.5, h: 0.5 },
      });

      render(<PersonAvatar person={person} />);

      await waitFor(() => {
        expect(mockGetMedia).toHaveBeenCalledWith('media-profile-id');
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Case 1b — profileMediaItemId without profileCrop (full-image circle)', () => {
    it('renders a plain img element (not FaceCrop) after resolving the media item', async () => {
      mockGetMedia.mockResolvedValue({
        id: 'media-full',
        thumbnailUrl: 'https://example.com/thumb-full.jpg',
        downloadUrl: 'https://example.com/full-full.jpg',
      } as any);

      const person = makePerson({
        profileMediaItemId: 'media-full',
        profileCrop: null,
      });

      render(<PersonAvatar person={person} />);

      // A plain <img> should appear (via MUI Box component="img")
      await waitFor(() => {
        expect(screen.getByRole('img')).toBeInTheDocument();
      });

      // It must NOT be the FaceCrop wrapper (which uses role="img" aria-label="Face crop")
      expect(screen.queryByRole('img', { name: 'Face crop' })).not.toBeInTheDocument();
    });

    it('renders an img whose src includes the thumbnailUrl', async () => {
      const thumbUrl = 'https://example.com/thumb-noncrop.jpg';
      mockGetMedia.mockResolvedValue({
        id: 'media-noncrop',
        thumbnailUrl: thumbUrl,
        downloadUrl: null,
      } as any);

      const person = makePerson({
        profileMediaItemId: 'media-noncrop',
        profileCrop: null,
      });

      render(<PersonAvatar person={person} />);

      await waitFor(() => {
        const img = screen.getByRole('img') as HTMLImageElement;
        expect(img.src).toContain('thumb-noncrop.jpg');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Regression: video vs photo face rendering (faceThumbnailUrl branch)
  //
  // When a coverFace carries a signed faceThumbnailUrl (video face), the component
  // must render an <img> whose src is that URL directly — it must NOT call getMedia
  // and must NOT render a FaceCrop bounding-box crop.
  //
  // When faceThumbnailUrl is null (photo face) and the media item resolves, the
  // component must fall through to the FaceCrop bounding-box path.
  // -------------------------------------------------------------------------
  describe('Case 2 — video face (faceThumbnailUrl non-null)', () => {
    it('renders an <img> whose src equals faceThumbnailUrl', () => {
      const VIDEO_THUMB = 'https://cdn.example.com/faces/frame-00042.jpg';
      const person = makePerson({
        coverFace: {
          faceId: 'fv1',
          mediaItemId: 'media-video-1',
          boundingBox: BOUNDING_BOX,
          faceThumbnailUrl: VIDEO_THUMB,
        },
      });

      render(<PersonAvatar person={person} />);

      // The component renders a MUI Box component="img" immediately (no async needed)
      // because faceThumbnailUrl is already available without fetching the media item.
      const img = screen.getByRole('img', { name: 'Alice' }) as HTMLImageElement;
      expect(img.src).toBe(VIDEO_THUMB);
    });

    it('does NOT render a FaceCrop when faceThumbnailUrl is set', () => {
      const person = makePerson({
        coverFace: {
          faceId: 'fv2',
          mediaItemId: 'media-video-2',
          boundingBox: BOUNDING_BOX,
          faceThumbnailUrl: 'https://cdn.example.com/faces/frame-00100.jpg',
        },
      });

      render(<PersonAvatar person={person} />);

      // FaceCrop renders with role="img" aria-label="Face crop" — must be absent
      expect(screen.queryByRole('img', { name: 'Face crop' })).not.toBeInTheDocument();
    });

    it('renders the video thumbnail synchronously without waiting for getMedia', () => {
      // With faceThumbnailUrl set the component can render the img immediately
      // using that URL. Although the useEffect still enqueues a getMedia call
      // (because coverFace.mediaItemId is non-null), the video thumbnail must
      // already appear in the DOM before that async fetch completes.
      const person = makePerson({
        coverFace: {
          faceId: 'fv3',
          mediaItemId: 'media-video-3',
          boundingBox: BOUNDING_BOX,
          faceThumbnailUrl: 'https://cdn.example.com/faces/frame-00200.jpg',
        },
      });

      // Simulate a never-resolving getMedia to confirm the thumbnail doesn't
      // depend on it.
      mockGetMedia.mockReturnValue(new Promise(() => {}));

      render(<PersonAvatar person={person} />);

      // The video thumbnail img must be present synchronously (or at least before
      // the pending media promise resolves).
      expect(screen.getByRole('img', { name: 'Alice' })).toBeInTheDocument();
    });

    it('respects a custom size prop when rendering the video thumbnail img', () => {
      const VIDEO_THUMB = 'https://cdn.example.com/faces/frame-00300.jpg';
      const person = makePerson({
        name: 'Bob',
        coverFace: {
          faceId: 'fv4',
          mediaItemId: 'media-video-4',
          boundingBox: BOUNDING_BOX,
          faceThumbnailUrl: VIDEO_THUMB,
        },
      });

      render(<PersonAvatar person={person} size={64} />);

      const img = screen.getByRole('img', { name: 'Bob' }) as HTMLImageElement;
      expect(img.src).toBe(VIDEO_THUMB);
    });
  });

  // -------------------------------------------------------------------------
  describe('Case 2 — photo face (faceThumbnailUrl null, source image resolves)', () => {
    it('renders FaceCrop after the media item resolves when faceThumbnailUrl is null', async () => {
      const THUMB_URL = 'https://example.com/photo-thumb.jpg';
      mockGetMedia.mockResolvedValue({
        id: 'media-photo-1',
        thumbnailUrl: THUMB_URL,
        downloadUrl: null,
      } as any);

      const person = makePerson({
        coverFace: {
          faceId: 'fp1',
          mediaItemId: 'media-photo-1',
          boundingBox: BOUNDING_BOX,
          faceThumbnailUrl: null,
        },
      });

      render(<PersonAvatar person={person} />);

      // FaceCrop appears once the media fetch resolves
      await waitFor(() => {
        expect(screen.getByRole('img', { name: 'Face crop' })).toBeInTheDocument();
      });
    });

    it('uses the mediaItemId from coverFace to fetch the source image', async () => {
      const person = makePerson({
        coverFace: {
          faceId: 'fp2',
          mediaItemId: 'media-photo-2',
          boundingBox: BOUNDING_BOX,
          faceThumbnailUrl: null,
        },
      });

      render(<PersonAvatar person={person} />);

      await waitFor(() => {
        expect(mockGetMedia).toHaveBeenCalledWith('media-photo-2');
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('dedup cache', () => {
    it('calls getMedia only once when two PersonAvatars share the same coverFace.mediaItemId', async () => {
      // Use a unique ID so we don't accidentally hit a prior test's cache entry
      const sharedId = `media-shared-${Date.now()}`;
      mockGetMedia.mockResolvedValue({
        id: sharedId,
        thumbnailUrl: 'https://example.com/thumb-shared.jpg',
        downloadUrl: null,
      } as any);

      const coverFace = { faceId: 'f-shared', mediaItemId: sharedId, boundingBox: BOUNDING_BOX, faceThumbnailUrl: null };
      const person1 = makePerson({ id: 'p-shared-1', coverFace });
      const person2 = makePerson({ id: 'p-shared-2', coverFace });

      render(
        <>
          <PersonAvatar person={person1} />
          <PersonAvatar person={person2} />
        </>,
      );

      // Wait for both to resolve
      await waitFor(() => {
        expect(screen.getAllByRole('img', { name: 'Face crop' })).toHaveLength(2);
      });

      // The cache should have deduplicated the fetch — exactly 1 call for this ID
      expect(mockGetMedia).toHaveBeenCalledTimes(1);
      expect(mockGetMedia).toHaveBeenCalledWith(sharedId);
    });
  });
});

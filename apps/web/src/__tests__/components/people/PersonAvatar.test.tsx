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
        coverFace: { faceId: 'f1', mediaItemId: 'media-cover', boundingBox: BOUNDING_BOX },
      });

      render(<PersonAvatar person={person} />);

      await waitFor(() => {
        expect(screen.getByRole('img', { name: 'Face crop' })).toBeInTheDocument();
      });
    });

    it('calls getMedia with the coverFace mediaItemId', async () => {
      const person = makePerson({
        coverFace: { faceId: 'f1', mediaItemId: 'media-cover-id', boundingBox: BOUNDING_BOX },
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
  describe('dedup cache', () => {
    it('calls getMedia only once when two PersonAvatars share the same coverFace.mediaItemId', async () => {
      // Use a unique ID so we don't accidentally hit a prior test's cache entry
      const sharedId = `media-shared-${Date.now()}`;
      mockGetMedia.mockResolvedValue({
        id: sharedId,
        thumbnailUrl: 'https://example.com/thumb-shared.jpg',
        downloadUrl: null,
      } as any);

      const coverFace = { faceId: 'f-shared', mediaItemId: sharedId, boundingBox: BOUNDING_BOX };
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

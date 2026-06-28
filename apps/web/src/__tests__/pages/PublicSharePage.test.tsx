/**
 * Tests for apps/web/src/pages/Public/PublicSharePage.tsx
 *
 * Covers:
 *  Loading state:
 *   - renders a spinner while loading
 *
 *  Error / unavailable:
 *   - renders neutral "This link is no longer available." message on API error
 *   - no download anchor/button is shown
 *
 *  Media item — photo:
 *   - renders an <img> whose src contains the public media proxy path
 *   - does not render a <video> element
 *   - no metadata text is shown (filename, date, description)
 *   - no download link/button is present
 *
 *  Media item — video:
 *   - renders a <video> whose src contains the public media proxy path
 *   - video has controlsList="nodownload..." attribute
 *   - does not render an <img> element
 *
 *  Album:
 *   - renders N grid tiles (img/video elements) for the N items
 *   - renders the item count in the header
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../utils/test-utils';
import type { PublicShareResponse } from '../../types/sharing';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before imports they affect
// ---------------------------------------------------------------------------

// Mock useParams so we control the token without needing full route matching.
// vi.mock is hoisted so the factory cannot reference const-bindings declared
// outside it — the mock is set up inline and then retrieved via vi.mocked().
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: vi.fn(() => ({ token: 'test-token' })),
  };
});

vi.mock('../../services/publicApi', () => ({
  getPublicShare: vi.fn(),
  publicMediaUrl: vi.fn(
    (token: string, idx: number) => `/api/public/shares/${token}/media/${idx}`,
  ),
  PublicApiError: class PublicApiError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
      this.name = 'PublicApiError';
    }
  },
}));

import { useParams } from 'react-router-dom';
import { getPublicShare } from '../../services/publicApi';
import PublicSharePage from '../../pages/Public/PublicSharePage';

const mockUseParams = vi.mocked(useParams);
const mockGetPublicShare = vi.mocked(getPublicShare);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPage(token = 'test-token') {
  mockUseParams.mockReturnValue({ token });
  return render(<PublicSharePage />, {
    wrapperOptions: { authenticated: false },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PublicSharePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseParams.mockReturnValue({ token: 'test-token' });
  });

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  describe('Loading state', () => {
    it('renders a spinner while the API request is in flight', () => {
      // Never resolves — stays in loading state
      mockGetPublicShare.mockReturnValue(new Promise(() => {}));

      renderPage();

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Error / unavailable
  // -------------------------------------------------------------------------

  describe('Error state', () => {
    beforeEach(() => {
      mockGetPublicShare.mockRejectedValue(new Error('Not found'));
    });

    it('shows the neutral "This link is no longer available." message', async () => {
      renderPage();

      await waitFor(() => {
        expect(
          screen.getByText(/this link is no longer available/i),
        ).toBeInTheDocument();
      });
    });

    it('does not show a download link or button', async () => {
      renderPage();

      await waitFor(() => screen.getByText(/this link is no longer available/i));

      const downloadEls = document.querySelectorAll('[download]');
      expect(downloadEls).toHaveLength(0);

      expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Media item — photo
  // -------------------------------------------------------------------------

  describe('Media item — photo', () => {
    const photoShare: PublicShareResponse = {
      type: 'media_item',
      media: { mediaType: 'photo', width: 1920, height: 1080 },
    };

    beforeEach(() => {
      mockGetPublicShare.mockResolvedValue(photoShare);
    });

    it('renders an <img> whose src contains the public media proxy path', async () => {
      renderPage('tok-photo');

      await waitFor(() => {
        const img = document.querySelector('img');
        expect(img).toBeTruthy();
        expect(img?.getAttribute('src')).toContain('/public/shares/tok-photo/media/0');
      });
    });

    it('does not render a <video> element', async () => {
      renderPage('tok-photo');

      await waitFor(() => document.querySelector('img'));

      expect(document.querySelector('video')).toBeNull();
    });

    it('does not show metadata text (filename, date, description)', async () => {
      renderPage('tok-photo');

      await waitFor(() => document.querySelector('img'));

      expect(screen.queryByText(/filename/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/captured/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/description/i)).not.toBeInTheDocument();
    });

    it('does not show a download link or button', async () => {
      renderPage('tok-photo');

      await waitFor(() => document.querySelector('img'));

      const downloadEls = document.querySelectorAll('[download]');
      expect(downloadEls).toHaveLength(0);

      expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
    });

    it('calls getPublicShare with the token from the URL', async () => {
      renderPage('my-share-token');

      await waitFor(() => {
        expect(mockGetPublicShare).toHaveBeenCalledWith('my-share-token');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Media item — video
  // -------------------------------------------------------------------------

  describe('Media item — video', () => {
    const videoShare: PublicShareResponse = {
      type: 'media_item',
      media: { mediaType: 'video', width: 1280, height: 720 },
    };

    beforeEach(() => {
      mockGetPublicShare.mockResolvedValue(videoShare);
    });

    it('renders a <video> element with the public media proxy src', async () => {
      renderPage('tok-video');

      await waitFor(() => {
        const video = document.querySelector('video');
        expect(video).toBeTruthy();
        expect(video?.getAttribute('src')).toContain('/public/shares/tok-video/media/0');
      });
    });

    it('video has controlsList attribute containing "nodownload"', async () => {
      renderPage('tok-video');

      await waitFor(() => document.querySelector('video'));

      const video = document.querySelector('video');
      const controlsList = video?.getAttribute('controlslist') ?? '';
      expect(controlsList).toContain('nodownload');
    });

    it('does not render an <img> element for a single video', async () => {
      renderPage('tok-video');

      await waitFor(() => document.querySelector('video'));

      const imgs = document.querySelectorAll('img');
      expect(imgs).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Album
  // -------------------------------------------------------------------------

  describe('Album share', () => {
    const albumShare: PublicShareResponse = {
      type: 'album',
      itemCount: 3,
      items: [
        { mediaType: 'photo', width: 1920, height: 1080 },
        { mediaType: 'photo', width: 800, height: 600 },
        { mediaType: 'video', width: 1280, height: 720 },
      ],
    };

    beforeEach(() => {
      mockGetPublicShare.mockResolvedValue(albumShare);
    });

    it('renders a grid tile (img or video) for each item in the album', async () => {
      renderPage('tok-album');

      await waitFor(() => {
        const photos = document.querySelectorAll('img');
        const videos = document.querySelectorAll('video');
        expect(photos.length + videos.length).toBe(3);
      });
    });

    it('renders "3 items" in the header', async () => {
      renderPage('tok-album');

      await waitFor(() => {
        expect(screen.getByText('3 items')).toBeInTheDocument();
      });
    });

    it('renders "Shared album" in the header', async () => {
      renderPage('tok-album');

      await waitFor(() => {
        expect(screen.getByText(/shared album/i)).toBeInTheDocument();
      });
    });

    it('renders singular "1 item" label for single-item album', async () => {
      const singleAlbum: PublicShareResponse = {
        type: 'album',
        itemCount: 1,
        items: [{ mediaType: 'photo', width: 100, height: 100 }],
      };
      mockGetPublicShare.mockResolvedValue(singleAlbum);

      renderPage('tok-album-single');

      await waitFor(() => {
        expect(screen.getByText('1 item')).toBeInTheDocument();
      });
    });

    it('images in album tiles have src containing the correct proxy path per index', async () => {
      const photoOnlyAlbum: PublicShareResponse = {
        type: 'album',
        itemCount: 2,
        items: [
          { mediaType: 'photo', width: 1920, height: 1080 },
          { mediaType: 'photo', width: 800, height: 600 },
        ],
      };
      mockGetPublicShare.mockResolvedValue(photoOnlyAlbum);

      renderPage('tok-album-photos');

      await waitFor(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        expect(imgs.length).toBe(2);
        expect(imgs[0].getAttribute('src')).toContain('/public/shares/tok-album-photos/media/0');
        expect(imgs[1].getAttribute('src')).toContain('/public/shares/tok-album-photos/media/1');
      });
    });
  });
});

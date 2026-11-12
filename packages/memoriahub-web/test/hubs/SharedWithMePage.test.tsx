import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('../../src/media/headless/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/media/headless/index.js')>();
  return { ...actual, listSharedAlbums: vi.fn(), listSharedMedia: vi.fn() };
});
vi.mock('../../src/viewer/ui/index.js', () => ({ MediaLightbox: () => null }));

import { render } from '../utils/test-utils.js';
import SharedWithMePage from '../../src/hubs/ui/pages/SharedWithMePage.js';
import { listSharedAlbums, listSharedMedia } from '../../src/media/headless/index.js';

const emptyMeta = { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 };

describe('SharedWithMePage (RETRO-I6 #588)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the empty state when nothing is shared', async () => {
    vi.mocked(listSharedAlbums).mockResolvedValue({ items: [], meta: emptyMeta });
    vi.mocked(listSharedMedia).mockResolvedValue({ items: [], meta: emptyMeta });
    render(<SharedWithMePage />);
    expect(await screen.findByText('Nothing is shared with you yet')).toBeInTheDocument();
  });

  it('lists the shared albums, linking to the album page', async () => {
    vi.mocked(listSharedAlbums).mockResolvedValue({
      items: [
        {
          id: 'album-1',
          name: 'Trip Alpha',
          description: null,
          addedById: 'user-b',
          circleId: 'group-b',
          createdAt: '',
          updatedAt: '',
          itemCount: 3,
          coverThumbnailUrl: null,
        },
      ],
      meta: { ...emptyMeta, totalItems: 1, totalPages: 1 },
    });
    vi.mocked(listSharedMedia).mockResolvedValue({ items: [], meta: emptyMeta });
    render(<SharedWithMePage />);
    const link = await screen.findByRole('link', { name: /Trip Alpha/ });
    expect(link).toHaveAttribute('href', '/albums/album-1');
    expect(screen.getByText('3 items')).toBeInTheDocument();
    expect(screen.getByText('No shared photos or videos.')).toBeInTheDocument();
  });
});

/**
 * Component tests — AlbumsPage (/albums)
 *
 * Mocking strategy (mirrors AlbumPage.test.tsx):
 *   - useCircle is mocked to supply an active circle and per-circle role.
 *   - listAlbums / createAlbum / updateAlbum / deleteAlbum service functions
 *     are mocked so no real HTTP calls are made (useAlbums calls listAlbums
 *     internally).
 *   - CreateAlbumDialog is stubbed to avoid rendering its internals — the
 *     "New Album" flow is out of scope for this test file.
 *
 * Test scenarios:
 *   1. Renders an album card per item returned by listAlbums, showing each
 *      album's name and item count.
 *   2. Shows an empty state when there are no albums.
 *   3. Shows an info Alert when no circle is active (no listAlbums call).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../../../__tests__/utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — declared before imports of mocked modules
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../../services/media', () => ({
  listAlbums: vi.fn(),
  createAlbum: vi.fn(),
  updateAlbum: vi.fn(),
  deleteAlbum: vi.fn(),
}));

// Stub CreateAlbumDialog — the "New Album" creation flow is covered by its
// own test file (components/album/__tests__/CreateAlbumDialog.test.tsx).
vi.mock('../../../components/album/CreateAlbumDialog', () => ({
  CreateAlbumDialog: () => null,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import AlbumsPage from '../AlbumsPage';
import { useCircle } from '../../../hooks/useCircle';
import { listAlbums } from '../../../services/media';

const mockUseCircle = vi.mocked(useCircle);
const mockListAlbums = vi.mocked(listAlbums);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const defaultActiveCircle = {
  id: 'circle-1',
  name: "Test User's Library",
  isPersonal: true,
  ownerId: 'test-user-id',
  description: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const albumFixtures = [
  {
    id: 'album-1',
    name: 'Summer 2024',
    description: null,
    addedById: 'test-user-id',
    circleId: 'circle-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    itemCount: 12,
    coverThumbnailUrl: 'https://cdn.example.com/album-1-cover.jpg',
    dateRange: { min: '2024-06-01T00:00:00.000Z', max: '2024-06-30T00:00:00.000Z' },
  },
  {
    id: 'album-2',
    name: 'Birthday Party',
    description: null,
    addedById: 'test-user-id',
    circleId: 'circle-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    itemCount: 0,
    coverThumbnailUrl: null,
    dateRange: null,
  },
];

function setupDefaults(overrides: { role?: string } = {}) {
  mockUseCircle.mockReturnValue({
    circles: [defaultActiveCircle],
    activeCircle: defaultActiveCircle,
    activeCircleId: 'circle-1',
    activeCircleRole: (overrides.role ?? 'collaborator') as any,
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
  });

  mockListAlbums.mockResolvedValue({
    items: albumFixtures,
    meta: { page: 1, pageSize: 100, totalItems: albumFixtures.length, totalPages: 1 },
  } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AlbumsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Album grid rendering', () => {
    it('renders an album card for each album with its name and item count', async () => {
      setupDefaults();
      render(<AlbumsPage />);

      await waitFor(() => {
        expect(screen.getByText('Summer 2024')).toBeInTheDocument();
      });

      expect(screen.getByText('Birthday Party')).toBeInTheDocument();
      expect(screen.getByText('12 items')).toBeInTheDocument();
      expect(screen.getByText('0 items')).toBeInTheDocument();
    });

    it('calls listAlbums scoped to the active circle', async () => {
      setupDefaults();
      render(<AlbumsPage />);

      await waitFor(() => {
        expect(mockListAlbums).toHaveBeenCalledWith(
          expect.objectContaining({ circleId: 'circle-1' }),
        );
      });
    });

    it('shows an empty state when there are no albums', async () => {
      setupDefaults();
      mockListAlbums.mockResolvedValue({
        items: [],
        meta: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 },
      } as any);

      render(<AlbumsPage />);

      await waitFor(() => {
        expect(screen.getByText('No albums yet')).toBeInTheDocument();
      });
    });
  });

  describe('No active circle', () => {
    it('shows an info Alert and does not call listAlbums when no circle is active', () => {
      mockUseCircle.mockReturnValue({
        circles: [],
        activeCircle: null,
        activeCircleId: null,
        activeCircleRole: null,
        loading: false,
        setActiveCircle: vi.fn().mockResolvedValue(undefined),
        refreshCircles: vi.fn().mockResolvedValue(undefined),
      });

      render(<AlbumsPage />);

      expect(screen.getByRole('alert')).toHaveTextContent(/select a circle/i);
      expect(mockListAlbums).not.toHaveBeenCalled();
    });
  });
});

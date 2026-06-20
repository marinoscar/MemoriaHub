/**
 * Component tests — AlbumPage (/albums/:albumId)
 *
 * Mocking strategy:
 *   - useParams is overridden to supply albumId without a real router match.
 *   - useCircle is mocked to supply an active circle and per-circle role.
 *   - getAlbum / updateAlbum / deleteAlbum service functions are mocked so no
 *     real HTTP calls are made.
 *   - MediaGallery is stubbed to a lightweight placeholder — album-gallery
 *     internals are covered by MediaGallery's own test file.
 *   - useNavigate is mocked so we can assert redirect after deletion.
 *
 * Test scenarios:
 *   1. Renders the album title and optional description from getAlbum.
 *   2. Shows a loading spinner while getAlbum is in-flight.
 *   3. Shows an error Alert when getAlbum rejects.
 *   4. Rename action: opens dialog, fills fields, calls updateAlbum.
 *   5. Delete action: opens confirm dialog, calls deleteAlbum, navigates to /albums.
 *   6. No album actions menu when activeCircleRole is 'viewer'.
 *   7. No-circle guard: shows an info Alert when activeCircle is null.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../__tests__/utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — declared before imports of mocked modules
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: vi.fn(),
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../../services/media', () => ({
  getAlbum: vi.fn(),
  updateAlbum: vi.fn(),
  deleteAlbum: vi.fn(),
}));

// Stub MediaGallery to avoid useInfiniteMedia / listMedia calls.
vi.mock('../../../components/media/MediaGallery', () => ({
  MediaGallery: vi.fn(() => <div data-testid="media-gallery-stub" />),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import AlbumPage from '../AlbumPage';
import { useParams } from 'react-router-dom';
import { useCircle } from '../../../hooks/useCircle';
import { getAlbum, updateAlbum, deleteAlbum } from '../../../services/media';

const mockUseParams = vi.mocked(useParams);
const mockUseCircle = vi.mocked(useCircle);
const mockGetAlbum = vi.mocked(getAlbum);
const mockUpdateAlbum = vi.mocked(updateAlbum);
const mockDeleteAlbum = vi.mocked(deleteAlbum);

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

const defaultAlbumDetail = {
  id: 'album-1',
  name: 'Summer 2024',
  description: 'Photos from our summer trip',
  circleId: 'circle-1',
  addedById: 'test-user-id',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  items: [],
};

function setupDefaults(overrides: { role?: string } = {}) {
  mockUseParams.mockReturnValue({ albumId: 'album-1' });

  mockUseCircle.mockReturnValue({
    circles: [defaultActiveCircle],
    activeCircle: defaultActiveCircle,
    activeCircleId: 'circle-1',
    activeCircleRole: (overrides.role ?? 'circle_admin') as any,
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
  });

  mockGetAlbum.mockResolvedValue(defaultAlbumDetail as any);
  mockUpdateAlbum.mockResolvedValue({ ...defaultAlbumDetail, name: 'Updated Name' } as any);
  mockDeleteAlbum.mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AlbumPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockReset();
  });

  // -------------------------------------------------------------------------
  // 1. Album header rendering
  // -------------------------------------------------------------------------
  describe('Album header', () => {
    it('renders the album title returned by getAlbum', async () => {
      setupDefaults();
      render(<AlbumPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /summer 2024/i })).toBeInTheDocument();
      });
    });

    it('renders the album description when present', async () => {
      setupDefaults();
      render(<AlbumPage />);

      await waitFor(() => {
        expect(screen.getByText(/photos from our summer trip/i)).toBeInTheDocument();
      });
    });

    it('does NOT render description when the album has none', async () => {
      setupDefaults();
      mockGetAlbum.mockResolvedValue({ ...defaultAlbumDetail, description: null } as any);
      render(<AlbumPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /summer 2024/i })).toBeInTheDocument();
      });
      expect(screen.queryByText(/photos from our summer trip/i)).not.toBeInTheDocument();
    });

    it('renders a back link to /albums', async () => {
      setupDefaults();
      render(<AlbumPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /albums/i })).toBeInTheDocument();
      });
    });

    it('renders the MediaGallery stub', async () => {
      setupDefaults();
      render(<AlbumPage />);

      await waitFor(() => {
        expect(screen.getByTestId('media-gallery-stub')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // 2. Loading state
  // -------------------------------------------------------------------------
  describe('Loading state', () => {
    it('shows a spinner while getAlbum is pending', async () => {
      setupDefaults();
      // Never resolves during this test
      mockGetAlbum.mockReturnValue(new Promise(() => {}));
      render(<AlbumPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Error state
  // -------------------------------------------------------------------------
  describe('Error state', () => {
    it('shows an error Alert when getAlbum rejects', async () => {
      setupDefaults();
      mockGetAlbum.mockRejectedValue(new Error('Album not found'));
      render(<AlbumPage />);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent(/album not found/i);
      });
    });
  });

  // -------------------------------------------------------------------------
  // 4. Rename action
  // -------------------------------------------------------------------------
  describe('Rename action', () => {
    it('opens the rename dialog when "Rename" is clicked in the actions menu', async () => {
      setupDefaults();
      const user = userEvent.setup();
      render(<AlbumPage />);

      // Wait for album to load
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /summer 2024/i })).toBeInTheDocument();
      });

      // Open the actions menu (MoreVert icon button)
      await user.click(screen.getByRole('button', { name: /album actions/i }));

      // Click "Rename" in the menu
      const renameMenuItem = screen.getByText(/^rename$/i);
      await user.click(renameMenuItem);

      // Rename dialog should open
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /rename album/i })).toBeInTheDocument();
      });
    });

    it('calls updateAlbum when the rename form is submitted', async () => {
      setupDefaults();
      const user = userEvent.setup();
      render(<AlbumPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /summer 2024/i })).toBeInTheDocument();
      });

      // Open menu → Rename
      await user.click(screen.getByRole('button', { name: /album actions/i }));
      await user.click(screen.getByText(/^rename$/i));

      // Clear the name field and type a new name
      const nameInput = await screen.findByLabelText(/album name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'Winter Wonderland');

      // Submit
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(mockUpdateAlbum).toHaveBeenCalledWith(
          'album-1',
          expect.objectContaining({ name: 'Winter Wonderland' }),
        );
      });
    });

    it('Save button is disabled when the name field is empty', async () => {
      setupDefaults();
      const user = userEvent.setup();
      render(<AlbumPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /summer 2024/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /album actions/i }));
      await user.click(screen.getByText(/^rename$/i));

      const nameInput = await screen.findByLabelText(/album name/i);
      await user.clear(nameInput);

      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Delete action
  // -------------------------------------------------------------------------
  describe('Delete action', () => {
    it('opens the delete confirm dialog when "Delete album" is clicked', async () => {
      setupDefaults();
      const user = userEvent.setup();
      render(<AlbumPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /summer 2024/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /album actions/i }));
      await user.click(screen.getByText(/delete album/i));

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /delete album/i })).toBeInTheDocument();
      });
    });

    it('calls deleteAlbum and navigates to /albums on confirm', async () => {
      setupDefaults();
      const user = userEvent.setup();
      render(<AlbumPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /summer 2024/i })).toBeInTheDocument();
      });

      // Open menu → Delete
      await user.click(screen.getByRole('button', { name: /album actions/i }));
      await user.click(screen.getByText(/delete album/i));

      // Confirm delete
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(mockDeleteAlbum).toHaveBeenCalledWith('album-1');
        expect(mockNavigate).toHaveBeenCalledWith('/albums');
      });
    });
  });

  // -------------------------------------------------------------------------
  // 6. Viewer role — no album actions
  // -------------------------------------------------------------------------
  describe('Viewer role', () => {
    it('does NOT show the album actions (MoreVert) button for viewers', async () => {
      setupDefaults({ role: 'viewer' });
      render(<AlbumPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /summer 2024/i })).toBeInTheDocument();
      });

      expect(
        screen.queryByRole('button', { name: /album actions/i }),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 7. No-circle guard
  // -------------------------------------------------------------------------
  describe('No active circle', () => {
    it('shows an info Alert when no circle is active', () => {
      mockUseParams.mockReturnValue({ albumId: 'album-1' });
      mockUseCircle.mockReturnValue({
        circles: [],
        activeCircle: null,
        activeCircleId: null,
        activeCircleRole: null,
        loading: false,
        setActiveCircle: vi.fn().mockResolvedValue(undefined),
        refreshCircles: vi.fn().mockResolvedValue(undefined),
      });

      render(<AlbumPage />);

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(/select a circle/i);
    });

    it('shows an error Alert when albumId is missing', () => {
      mockUseParams.mockReturnValue({});
      mockUseCircle.mockReturnValue({
        circles: [defaultActiveCircle],
        activeCircle: defaultActiveCircle,
        activeCircleId: 'circle-1',
        activeCircleRole: 'circle_admin' as any,
        loading: false,
        setActiveCircle: vi.fn().mockResolvedValue(undefined),
        refreshCircles: vi.fn().mockResolvedValue(undefined),
      });

      render(<AlbumPage />);

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(/album not found/i);
    });
  });
});

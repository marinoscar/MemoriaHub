/**
 * Component tests — HomePage (refactored to feed-based gallery)
 *
 * After the unify-gallery refactor, HomePage is a minimal page that:
 *   - Shows a "Select or create a circle" alert when no circle is active
 *   - Renders <MediaGallery> in feed mode when a circle is active
 *   - Shows an Upload FAB when a circle is active
 *   - Opens MediaUploadDialog on FAB click
 *
 * MediaGallery is mocked to isolate HomePage chrome tests from gallery
 * internals. The MediaUploadDialog is also mocked to avoid service calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render, mockUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

// Mock MediaGallery so its internal useInfiniteMedia / listMedia calls never fire.
vi.mock('../../components/media/MediaGallery', () => ({
  MediaGallery: vi.fn(({ emptyState }: { emptyState?: React.ReactNode }) => (
    <div data-testid="media-gallery">{emptyState}</div>
  )),
}));

// Mock MediaUploadDialog to avoid upload service calls in these tests.
vi.mock('../../components/media/MediaUploadDialog', () => ({
  MediaUploadDialog: vi.fn(({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? <div data-testid="upload-dialog"><button onClick={onClose}>Close</button></div> : null,
  ),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import HomePage from '../../pages/HomePage';
import { useCircle } from '../../hooks/useCircle';

const mockUseCircle = vi.mocked(useCircle);

// ---------------------------------------------------------------------------
// Shared fixtures
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

function setupActiveCircle() {
  mockUseCircle.mockReturnValue({
    circles: [defaultActiveCircle],
    activeCircle: defaultActiveCircle,
    activeCircleId: 'circle-1',
    activeCircleRole: 'circle_admin',
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
  });
}

function setupNoCircle() {
  mockUseCircle.mockReturnValue({
    circles: [],
    activeCircle: null,
    activeCircleId: null,
    activeCircleRole: null,
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
  });
}

function setupCircleLoading() {
  mockUseCircle.mockReturnValue({
    circles: [],
    activeCircle: null,
    activeCircleId: null,
    activeCircleRole: null,
    loading: true,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // a) No active circle
  // -------------------------------------------------------------------------
  describe('No active circle', () => {
    it('shows "Select or create a circle" alert when no circle is active', () => {
      setupNoCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(
        screen.getByText(/select or create a circle to get started/i),
      ).toBeInTheDocument();
    });

    it('does NOT render MediaGallery when no circle is active', () => {
      setupNoCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.queryByTestId('media-gallery')).not.toBeInTheDocument();
    });

    it('does NOT render the Upload FAB when no circle is active', () => {
      setupNoCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(
        screen.queryByRole('button', { name: /upload media/i }),
      ).not.toBeInTheDocument();
    });

    it('does NOT show no-circle alert when circle is loading', () => {
      setupCircleLoading();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // While loading, neither alert nor gallery is shown
      expect(
        screen.queryByText(/select or create a circle/i),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // b) Active circle — gallery and FAB
  // -------------------------------------------------------------------------
  describe('Active circle', () => {
    it('renders MediaGallery when a circle is active', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByTestId('media-gallery')).toBeInTheDocument();
    });

    it('does NOT show the no-circle alert when a circle is active', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(
        screen.queryByText(/select or create a circle to get started/i),
      ).not.toBeInTheDocument();
    });

    it('shows the Upload FAB when a circle is active', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // Both the FAB and the emptyState CTA (rendered by the MediaGallery mock) have
      // aria-label="Upload media", so we check at least one is present.
      const uploadBtns = screen.getAllByRole('button', { name: /upload media/i });
      expect(uploadBtns.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // c) Empty state inside MediaGallery
  // -------------------------------------------------------------------------
  describe('Empty state', () => {
    it('passes an emptyState prop to MediaGallery that includes "No memories here yet"', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // The mock renders children (emptyState) inside the data-testid element.
      expect(screen.getByText(/no memories here yet/i)).toBeInTheDocument();
    });

    it('shows an Upload Media button inside the empty state', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // There is the FAB AND the empty-state CTA; both should be present.
      const uploadBtns = screen.getAllByRole('button', { name: /upload media/i });
      expect(uploadBtns.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // d) Upload dialog
  // -------------------------------------------------------------------------
  describe('Upload dialog', () => {
    it('opens MediaUploadDialog when the FAB is clicked', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // The FAB is the first "Upload media" button in the DOM (rendered before the
      // emptyState which is inside MediaGallery mock).
      const uploadBtns = screen.getAllByRole('button', { name: /upload media/i });
      fireEvent.click(uploadBtns[0]);

      expect(screen.getByTestId('upload-dialog')).toBeInTheDocument();
    });

    it('closes MediaUploadDialog when its onClose is triggered', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // Open via first upload button (FAB)
      const uploadBtns = screen.getAllByRole('button', { name: /upload media/i });
      fireEvent.click(uploadBtns[0]);
      expect(screen.getByTestId('upload-dialog')).toBeInTheDocument();

      // Close
      fireEvent.click(screen.getByRole('button', { name: /close/i }));
      expect(screen.queryByTestId('upload-dialog')).not.toBeInTheDocument();
    });

    it('opens upload dialog from the empty-state Upload Media button', () => {
      setupActiveCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // The empty-state "Upload Media" button (not the FAB)
      const uploadBtns = screen.getAllByRole('button', { name: /upload media/i });
      // Click the second one — first is FAB, second is inside the empty state
      fireEvent.click(uploadBtns[1]);

      expect(screen.getByTestId('upload-dialog')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // e) "Go to Circles" link in no-circle alert
  // -------------------------------------------------------------------------
  describe('Go to Circles link', () => {
    it('renders a "Go to Circles" link in the no-circle alert', () => {
      setupNoCircle();
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByRole('link', { name: /go to circles/i })).toBeInTheDocument();
    });
  });
});

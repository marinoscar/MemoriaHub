/**
 * Component tests — MemoriesPage
 *
 * MemoriesPage is the gallery page that:
 *   - Shows a "Select or create a circle" alert when no circle is active
 *   - Renders <MediaGallery> when a circle is active
 *   - Passes an emptyState prop containing "No memories here yet" and
 *     a reference to the "Upload button in the toolbar"
 *
 * MediaGallery is mocked to isolate MemoriesPage chrome tests from gallery
 * internals. The mock renders its emptyState child so empty-state assertions
 * can be checked without a real gallery implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render, mockUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

// Mock MediaGallery so its internal useInfiniteMedia / listMedia calls never fire.
// The mock renders emptyState so empty-state text assertions work.
vi.mock('../../components/media/MediaGallery', () => ({
  MediaGallery: vi.fn(({ emptyState }: { emptyState?: React.ReactNode }) => (
    <div data-testid="media-gallery">{emptyState}</div>
  )),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import MemoriesPage from '../../pages/MemoriesPage';
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

describe('MemoriesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // a) No active circle
  // -------------------------------------------------------------------------
  describe('No active circle', () => {
    it('shows "Select or create a circle" alert when no circle is active', () => {
      setupNoCircle();
      render(<MemoriesPage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(
        screen.getByText(/select or create a circle to get started/i),
      ).toBeInTheDocument();
    });

    it('renders a "Go to Circles" link in the no-circle alert', () => {
      setupNoCircle();
      render(<MemoriesPage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByRole('link', { name: /go to circles/i })).toBeInTheDocument();
    });

    it('does NOT render MediaGallery when no circle is active', () => {
      setupNoCircle();
      render(<MemoriesPage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.queryByTestId('media-gallery')).not.toBeInTheDocument();
    });

    it('does NOT show no-circle alert when circle is loading', () => {
      setupCircleLoading();
      render(<MemoriesPage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // While loading, the alert is suppressed
      expect(
        screen.queryByText(/select or create a circle/i),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // b) Active circle — gallery rendered
  // -------------------------------------------------------------------------
  describe('Active circle', () => {
    it('renders MediaGallery when a circle is active', () => {
      setupActiveCircle();
      render(<MemoriesPage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByTestId('media-gallery')).toBeInTheDocument();
    });

    it('does NOT show the no-circle alert when a circle is active', () => {
      setupActiveCircle();
      render(<MemoriesPage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(
        screen.queryByText(/select or create a circle to get started/i),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // c) Empty state inside MediaGallery
  // -------------------------------------------------------------------------
  describe('Empty state', () => {
    it('passes an emptyState prop to MediaGallery that includes "No memories here yet"', () => {
      setupActiveCircle();
      render(<MemoriesPage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // The mock renders children (emptyState) inside the data-testid element.
      expect(screen.getByText(/no memories here yet/i)).toBeInTheDocument();
    });

    it('mentions the Upload button in the toolbar in the empty state text', () => {
      setupActiveCircle();
      render(<MemoriesPage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // Empty state refers to "Upload button in the toolbar"
      expect(screen.getByText(/upload button in the toolbar/i)).toBeInTheDocument();
    });
  });
});

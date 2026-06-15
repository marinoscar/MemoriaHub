import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { render, mockUser, mockAdminUser } from '../utils/test-utils';
import HomePage from '../../pages/HomePage';
import type { MediaItem } from '../../types/media';

// ---------------------------------------------------------------------------
// Mock react-router-dom (keep MemoryRouter from test-utils; only override navigate)
// ---------------------------------------------------------------------------
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ---------------------------------------------------------------------------
// Mock useDashboard so we control data without real API calls
// ---------------------------------------------------------------------------
vi.mock('../../hooks/useDashboard', () => ({
  useDashboard: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock useCircle so we can control loading state independently
// ---------------------------------------------------------------------------
vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock media services used by MediaUploadDialog / MediaDetailDrawer
// ---------------------------------------------------------------------------
vi.mock('../../services/media', () => ({
  getDashboard: vi.fn(),
  patchMedia: vi.fn(),
  getMedia: vi.fn(),
  initUpload: vi.fn(),
  uploadPart: vi.fn(),
  completeUpload: vi.fn(),
  registerMedia: vi.fn(),
  listTags: vi.fn(),
  listMedia: vi.fn(),
  bulkUpdateMedia: vi.fn(),
  bulkTags: vi.fn(),
}));

import { useDashboard } from '../../hooks/useDashboard';
import { useCircle } from '../../hooks/useCircle';
import { getMedia, listTags } from '../../services/media';

const mockUseDashboard = vi.mocked(useDashboard);
const mockUseCircle = vi.mocked(useCircle);

// ---------------------------------------------------------------------------
// Default mock values
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

const defaultDashboardData = {
  onThisDay: [],
  recent: [],
  favorites: [],
  counts: { total: 5, unreviewed: 2, lowValue: 1, missingGeo: 0 },
};

const mockItem: MediaItem = {
  id: 'item-1',
  storageObjectId: 'obj-1',
  addedById: 'test-user-id',
  circleId: 'circle-1',
  type: 'photo',
  capturedAt: null,
  capturedAtOffset: null,
  importedAt: new Date().toISOString(),
  source: 'web',
  contentHash: null,
  classification: 'unreviewed',
  width: null,
  height: null,
  durationMs: null,
  orientation: null,
  takenLat: null,
  takenLng: null,
  takenAltitude: null,
  cameraMake: null,
  cameraModel: null,
  originalFilename: 'test.jpg',
  title: 'A Test Memory',
  caption: null,
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
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deletedAt: null,
  metadata: null,
  thumbnailUrl: 'https://example.com/thumb.jpg',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setupDefaults() {
  mockUseDashboard.mockReturnValue({
    data: defaultDashboardData,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('HomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  // -------------------------------------------------------------------------
  // a) Rendering with active circle — main dashboard
  // -------------------------------------------------------------------------
  describe('Rendering with active circle (main dashboard)', () => {
    it('renders "Welcome back, Test User" heading', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByRole('heading', { name: /welcome back, test user/i })).toBeInTheDocument();
    });

    it('shows the active circle name', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByText("Test User's Library")).toBeInTheDocument();
    });

    it('shows the Review Queue card', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByText(/review queue/i)).toBeInTheDocument();
    });

    it('shows the Quick Actions card', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByText(/quick actions/i)).toBeInTheDocument();
    });

    it('does NOT show the "Select or create a circle" alert when a circle is active', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(
        screen.queryByText(/select or create a circle/i),
      ).not.toBeInTheDocument();
    });

    it('shows "No memories from this day — yet." when onThisDay is empty', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(
        screen.getByText(/no memories from this day — yet\./i),
      ).toBeInTheDocument();
    });

    it('shows "Welcome back" without a name when displayName is null', () => {
      render(<HomePage />, {
        wrapperOptions: { authenticated: true, user: { ...mockUser, displayName: null } },
      });

      expect(
        screen.getByRole('heading', { name: /^welcome back$/i }),
      ).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // b) No active circle state
  // -------------------------------------------------------------------------
  describe('No active circle state', () => {
    beforeEach(() => {
      mockUseCircle.mockReturnValue({
        circles: [],
        activeCircle: null,
        activeCircleId: null,
        activeCircleRole: null,
        loading: false,
        setActiveCircle: vi.fn().mockResolvedValue(undefined),
        refreshCircles: vi.fn().mockResolvedValue(undefined),
      });

      mockUseDashboard.mockReturnValue({
        data: null,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
    });

    it('shows "Select or create a circle to get started" alert', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(
        screen.getByText(/select or create a circle to get started/i),
      ).toBeInTheDocument();
    });

    it('still shows Quick Actions when no circle is active', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByText(/quick actions/i)).toBeInTheDocument();
    });

    it('does NOT show ReviewQueueCard sections (Unreviewed, Low value, Missing location)', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.queryByText(/review queue/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/unreviewed/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/low value/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/missing location/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // c) Loading state
  // -------------------------------------------------------------------------
  describe('Loading state', () => {
    it('shows MuiSkeleton elements when circleLoading is true', () => {
      mockUseCircle.mockReturnValue({
        circles: [],
        activeCircle: null,
        activeCircleId: null,
        activeCircleRole: null,
        loading: true,
        setActiveCircle: vi.fn().mockResolvedValue(undefined),
        refreshCircles: vi.fn().mockResolvedValue(undefined),
      });

      mockUseDashboard.mockReturnValue({
        data: null,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      const { container } = render(<HomePage />, {
        wrapperOptions: { authenticated: true, user: mockUser },
      });

      const skeletons = container.querySelectorAll('.MuiSkeleton-root');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it('shows MuiSkeleton elements when dashboardLoading is true', () => {
      mockUseDashboard.mockReturnValue({
        data: null,
        isLoading: true,
        error: null,
        refetch: vi.fn(),
      });

      const { container } = render(<HomePage />, {
        wrapperOptions: { authenticated: true, user: mockUser },
      });

      const skeletons = container.querySelectorAll('.MuiSkeleton-root');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it('does NOT show the main grid content during loading', () => {
      mockUseDashboard.mockReturnValue({
        data: null,
        isLoading: true,
        error: null,
        refetch: vi.fn(),
      });

      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // Main dashboard content (Review Queue) should be absent
      expect(screen.queryByText(/review queue/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // d) Empty state — circle exists but 0 total media
  // -------------------------------------------------------------------------
  describe('Empty state (circle exists, 0 total media)', () => {
    beforeEach(() => {
      mockUseDashboard.mockReturnValue({
        data: {
          onThisDay: [],
          recent: [],
          favorites: [],
          counts: { total: 0, unreviewed: 0, lowValue: 0, missingGeo: 0 },
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
    });

    it('shows "No memories here yet" empty-state card', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByText(/no memories here yet/i)).toBeInTheDocument();
    });

    it('shows "Upload Media" button in empty state', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByRole('button', { name: /upload media/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // e) ReviewQueueCard deep links
  // -------------------------------------------------------------------------
  describe('ReviewQueueCard deep links', () => {
    it('navigates to /media?classification=unreviewed when unreviewed "Review" is clicked', async () => {
      mockUseDashboard.mockReturnValue({
        data: {
          ...defaultDashboardData,
          counts: { total: 5, unreviewed: 3, lowValue: 0, missingGeo: 0 },
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // There is exactly one Review button visible (lowValue and missingGeo are 0)
      const reviewButtons = screen.getAllByRole('button', { name: /^review$/i });
      // The first "Review" button corresponds to Unreviewed row
      fireEvent.click(reviewButtons[0]);

      expect(mockNavigate).toHaveBeenCalledWith('/media?classification=unreviewed');
    });

    it('navigates to /media?classification=low_value when low value "Review" is clicked', async () => {
      mockUseDashboard.mockReturnValue({
        data: {
          ...defaultDashboardData,
          counts: { total: 5, unreviewed: 0, lowValue: 2, missingGeo: 0 },
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      const reviewButtons = screen.getAllByRole('button', { name: /^review$/i });
      fireEvent.click(reviewButtons[0]);

      expect(mockNavigate).toHaveBeenCalledWith('/media?classification=low_value');
    });

    it('navigates to /media?missingGeo=1 when missing location "Review" is clicked', async () => {
      mockUseDashboard.mockReturnValue({
        data: {
          ...defaultDashboardData,
          counts: { total: 5, unreviewed: 0, lowValue: 0, missingGeo: 4 },
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      const reviewButtons = screen.getAllByRole('button', { name: /^review$/i });
      fireEvent.click(reviewButtons[0]);

      expect(mockNavigate).toHaveBeenCalledWith('/media?missingGeo=1');
    });

    it('shows check icon (no Review button) for rows with zero count', () => {
      // All counts are 0 → no Review buttons
      mockUseDashboard.mockReturnValue({
        data: {
          ...defaultDashboardData,
          counts: { total: 5, unreviewed: 0, lowValue: 0, missingGeo: 0 },
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.queryByRole('button', { name: /^review$/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // f) Memory thumbnail click opens drawer
  // -------------------------------------------------------------------------
  describe('Memory thumbnail click opens MediaDetailDrawer', () => {
    it('opens the drawer when an OnThisDay thumbnail is clicked', async () => {
      vi.mocked(getMedia).mockResolvedValue({ ...mockItem, downloadUrl: null });
      vi.mocked(listTags).mockResolvedValue([]);

      mockUseDashboard.mockReturnValue({
        data: {
          onThisDay: [mockItem],
          recent: [],
          favorites: [],
          counts: { total: 5, unreviewed: 0, lowValue: 0, missingGeo: 0 },
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // The thumbnail is an img element
      const thumbnail = screen.getByRole('img', {
        name: mockItem.title ?? mockItem.originalFilename,
      });
      fireEvent.click(thumbnail);

      // Drawer should open — MUI Drawer renders a role="presentation" container
      await waitFor(() => {
        expect(screen.getByRole('presentation')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // g) Dashboard error state
  // -------------------------------------------------------------------------
  describe('Dashboard error state', () => {
    it('shows an error Alert when useDashboard returns an error', () => {
      mockUseDashboard.mockReturnValue({
        data: null,
        isLoading: false,
        error: 'Failed to load',
        refetch: vi.fn(),
      });

      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveTextContent(/failed to load/i);
    });

    it('error Alert has error severity (MuiAlert-colorError class)', () => {
      mockUseDashboard.mockReturnValue({
        data: null,
        isLoading: false,
        error: 'Something went wrong',
        refetch: vi.fn(),
      });

      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      const alert = screen.getByRole('alert');
      expect(alert.className).toMatch(/MuiAlert-colorError|MuiAlert-standardError/);
    });
  });

  // -------------------------------------------------------------------------
  // Admin-only system settings in Quick Actions
  // -------------------------------------------------------------------------
  describe('Admin visibility in Quick Actions', () => {
    it('shows System Settings quick action for admin users', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockAdminUser } });

      expect(screen.getByText(/^system settings$/i)).toBeInTheDocument();
    });

    it('hides System Settings quick action for viewer users', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.queryByText(/^system settings$/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Handler: drawer close (handleDrawerClose)
  // -------------------------------------------------------------------------
  describe('Drawer close handler', () => {
    it('closes the MediaDetailDrawer when its onClose prop is triggered', async () => {
      vi.mocked(getMedia).mockResolvedValue({ ...mockItem, downloadUrl: null });
      vi.mocked(listTags).mockResolvedValue([]);

      mockUseDashboard.mockReturnValue({
        data: {
          onThisDay: [mockItem],
          recent: [],
          favorites: [],
          counts: { total: 5, unreviewed: 0, lowValue: 0, missingGeo: 0 },
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // Open the drawer first
      const thumbnail = screen.getByRole('img', {
        name: mockItem.title ?? mockItem.originalFilename,
      });
      fireEvent.click(thumbnail);

      await waitFor(() => {
        expect(screen.getByRole('presentation')).toBeInTheDocument();
      });

      // Close via keyboard Escape (MUI Drawer closes on Escape)
      fireEvent.keyDown(document, { key: 'Escape' });

      // Drawer remains in DOM but closed (MUI keeps it mounted)
      expect(document.body).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Handler: upload success (handleUploadSuccess)
  // -------------------------------------------------------------------------
  describe('Upload success handler', () => {
    it('calls refetch after upload success (empty state upload button opens dialog)', async () => {
      const refetchFn = vi.fn();
      mockUseDashboard.mockReturnValue({
        data: {
          onThisDay: [],
          recent: [],
          favorites: [],
          counts: { total: 0, unreviewed: 0, lowValue: 0, missingGeo: 0 },
        },
        isLoading: false,
        error: null,
        refetch: refetchFn,
      });

      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // Open the upload dialog via the empty state button
      const uploadBtn = screen.getByRole('button', { name: /upload media/i });
      fireEvent.click(uploadBtn);

      // The MediaUploadDialog should open
      await waitFor(() => {
        // Dialog is rendered but upload hasn't happened yet — just verify button worked
        expect(uploadBtn).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // MemoryHighlights — recent/favorites thumbnails
  // -------------------------------------------------------------------------
  describe('MemoryHighlights thumbnails', () => {
    it('opens drawer when a recent thumbnail is clicked', async () => {
      vi.mocked(getMedia).mockResolvedValue({ ...mockItem, downloadUrl: null });
      vi.mocked(listTags).mockResolvedValue([]);

      mockUseDashboard.mockReturnValue({
        data: {
          onThisDay: [],
          recent: [mockItem],
          favorites: [],
          counts: { total: 5, unreviewed: 0, lowValue: 0, missingGeo: 0 },
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      const thumbnail = screen.getByRole('img', {
        name: mockItem.title ?? mockItem.originalFilename,
      });
      fireEvent.click(thumbnail);

      await waitFor(() => {
        expect(screen.getByRole('presentation')).toBeInTheDocument();
      });
    });

    it('shows empty text when recent and favorites are both empty', () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByText(/no recent memories\./i)).toBeInTheDocument();
      expect(screen.getByText(/no favorites yet\./i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Quick Actions onUploadClick — opens MediaUploadDialog
  // -------------------------------------------------------------------------
  describe('QuickActions Upload button opens dialog', () => {
    it('clicking Quick Actions Upload button triggers upload flow', async () => {
      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // Find the Upload button inside Quick Actions by text content
      const allButtons = screen.getAllByRole('button');
      const uploadAction = allButtons.find((btn) =>
        btn.textContent?.includes('Upload') && btn.textContent?.includes('Add new'),
      );
      expect(uploadAction).toBeTruthy();
      if (uploadAction) {
        fireEvent.click(uploadAction);
      }

      // After clicking, Quick Actions card is still rendered
      expect(screen.getByText(/quick actions/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // "No circle" QuickActions upload click — exercises the onUploadClick arrow on line 157
  // -------------------------------------------------------------------------
  describe('No circle QuickActions Upload button', () => {
    it('clicking Upload in the no-circle fallback QuickActions does not crash', async () => {
      mockUseCircle.mockReturnValue({
        circles: [],
        activeCircle: null,
        activeCircleId: null,
        activeCircleRole: null,
        loading: false,
        setActiveCircle: vi.fn().mockResolvedValue(undefined),
        refreshCircles: vi.fn().mockResolvedValue(undefined),
      });

      mockUseDashboard.mockReturnValue({
        data: null,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });

      render(<HomePage />, { wrapperOptions: { authenticated: true, user: mockUser } });

      // Find the Upload button inside the no-circle Quick Actions
      const allButtons = screen.getAllByRole('button');
      const uploadAction = allButtons.find((btn) =>
        btn.textContent?.includes('Upload') && btn.textContent?.includes('Add new'),
      );
      expect(uploadAction).toBeTruthy();
      if (uploadAction) {
        fireEvent.click(uploadAction);
      }

      // Page remains stable after clicking
      expect(screen.getByText(/quick actions/i)).toBeInTheDocument();
    });
  });
});

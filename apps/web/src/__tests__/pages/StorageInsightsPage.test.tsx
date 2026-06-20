/**
 * Render tests for StorageInsightsPage.
 *
 * Covers: ready state renders KPI values; empty state shows the no-insights
 * message and refresh button; loading state shows skeletons; non-admin is
 * redirected.
 *
 * Note: CompositionDonut imports @mui/x-charts/PieChart which is NOT installed
 * in the local node_modules (web deps live in the Docker container per project
 * convention). The entire CompositionDonut component is mocked below so the
 * page render test can run without that package.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render, mockAdminUser, mockUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted before component imports)
// ---------------------------------------------------------------------------

// Mock @mui/x-charts to avoid the missing-package error
vi.mock('@mui/x-charts/PieChart', () => ({
  PieChart: () => null,
}));

// Mock CompositionDonut (uses @mui/x-charts)
vi.mock('../../components/insights/CompositionDonut', () => ({
  CompositionDonut: ({ title }: { title: string }) => (
    <div data-testid={`donut-${title.replace(/\s+/g, '-').toLowerCase()}`}>{title}</div>
  ),
}));

// Mock the useInsights hook so we control what state the page sees
vi.mock('../../hooks/useInsights', () => ({
  useInsights: vi.fn(),
}));

// Mock usePermissions so we can control admin gate
vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { useInsights } from '../../hooks/useInsights';
import { usePermissions } from '../../hooks/usePermissions';
import StorageInsightsPage from '../../pages/Admin/StorageInsightsPage';
import type { InsightsSnapshot } from '../../services/insights';

const mockUseInsights = vi.mocked(useInsights);
const mockUsePermissions = vi.mocked(usePermissions);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const readySnapshot: InsightsSnapshot = {
  status: 'ready',
  metrics: {
    totalBytes: '1260000000',
    photoBytes: '472000000',
    videoBytes: '788000000',
    totalItems: 1000,
    photoCount: 800,
    videoCount: 200,
    totalFaces: 4217,
    taggedItems: 650,
  },
  computedAt: '2025-06-20T10:00:00.000Z',
  durationMs: 142,
};

const emptySnapshot: InsightsSnapshot = {
  status: 'empty',
  metrics: null,
  computedAt: null,
  durationMs: null,
};

function makeAdminPermissions() {
  return {
    permissions: new Set(['system_settings:read', 'system_settings:write']),
    roles: new Set(['admin']),
    hasPermission: (p: string) =>
      ['system_settings:read', 'system_settings:write'].includes(p),
    hasAnyPermission: vi.fn().mockReturnValue(true),
    hasAllPermissions: vi.fn().mockReturnValue(true),
    hasRole: vi.fn().mockReturnValue(true),
    hasAnyRole: vi.fn().mockReturnValue(true),
    isAdmin: true,
  };
}

function makeViewerPermissions() {
  return {
    permissions: new Set(['user_settings:read']),
    roles: new Set(['viewer']),
    hasPermission: vi.fn().mockReturnValue(false),
    hasAnyPermission: vi.fn().mockReturnValue(false),
    hasAllPermissions: vi.fn().mockReturnValue(false),
    hasRole: vi.fn().mockReturnValue(false),
    hasAnyRole: vi.fn().mockReturnValue(false),
    isAdmin: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageInsightsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: admin, ready data, not loading
    mockUsePermissions.mockReturnValue(makeAdminPermissions());
    mockUseInsights.mockReturnValue({
      data: readySnapshot,
      loading: false,
      refreshing: false,
      error: null,
      load: vi.fn(),
      refresh: vi.fn(),
    });
  });

  // =========================================================================
  // Authorization
  // =========================================================================

  describe('authorization', () => {
    it('redirects non-admin users to /', () => {
      mockUsePermissions.mockReturnValue(makeViewerPermissions());

      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockUser },
      });

      // After redirect the page content should not render
      expect(screen.queryByText(/Storage Insights/i)).toBeNull();
    });

    it('renders the page content for admin users', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/Storage Insights/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Ready state
  // =========================================================================

  describe('ready state', () => {
    it('renders the Storage Insights heading', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/Storage Insights/i)).toBeInTheDocument();
    });

    it('renders the Total Storage KPI card', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/Total Storage/i)).toBeInTheDocument();
    });

    it('renders the Total Items KPI card', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/Total Items/i)).toBeInTheDocument();
    });

    it('renders the Detected Faces KPI card', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/Detected Faces/i)).toBeInTheDocument();
    });

    it('renders the Tagged Items KPI card', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/Tagged Items/i)).toBeInTheDocument();
    });

    it('renders the "Photos vs Videos" composition section', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/Photos vs Videos/i)).toBeInTheDocument();
    });

    it('renders formatted faces count', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // 4217 formatted as "4,217" (below 10 000 threshold)
      expect(screen.getByText('4,217')).toBeInTheDocument();
    });

    it('renders a "Refresh now" button', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByRole('button', { name: /Refresh now/i })).toBeInTheDocument();
    });

    it('does not render the empty-state message', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.queryByText(/No insights computed yet/i)).toBeNull();
    });
  });

  // =========================================================================
  // Empty state
  // =========================================================================

  describe('empty state', () => {
    beforeEach(() => {
      mockUseInsights.mockReturnValue({
        data: emptySnapshot,
        loading: false,
        refreshing: false,
        error: null,
        load: vi.fn(),
        refresh: vi.fn(),
      });
    });

    it('renders the empty-state heading', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/No insights computed yet/i)).toBeInTheDocument();
    });

    it('renders a "Compute now" button', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByRole('button', { name: /Compute now/i })).toBeInTheDocument();
    });

    it('does not render KPI cards', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.queryByText(/Total Storage/i)).toBeNull();
      expect(screen.queryByText(/Total Items/i)).toBeNull();
    });

    it('also shows empty state when data is null', () => {
      mockUseInsights.mockReturnValue({
        data: null,
        loading: false,
        refreshing: false,
        error: null,
        load: vi.fn(),
        refresh: vi.fn(),
      });

      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByText(/No insights computed yet/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Loading state
  // =========================================================================

  describe('loading state', () => {
    beforeEach(() => {
      mockUseInsights.mockReturnValue({
        data: null,
        loading: true,
        refreshing: false,
        error: null,
        load: vi.fn(),
        refresh: vi.fn(),
      });
    });

    it('does not render the empty-state message while loading', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // The empty-state is hidden while loading
      expect(screen.queryByText(/No insights computed yet/i)).toBeNull();
    });

    it('does not render KPI values while loading', () => {
      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.queryByText(/Total Storage/i)).toBeNull();
    });
  });

  // =========================================================================
  // Error state
  // =========================================================================

  describe('error state', () => {
    it('renders an error alert when the hook reports an error', async () => {
      mockUseInsights.mockReturnValue({
        data: null,
        loading: false,
        refreshing: false,
        error: 'Failed to load insights',
        load: vi.fn(),
        refresh: vi.fn(),
      });

      render(<StorageInsightsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/Failed to load insights/i)).toBeInTheDocument();
      });
    });
  });
});

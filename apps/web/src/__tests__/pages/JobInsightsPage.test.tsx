/**
 * Render tests for JobInsightsPage.
 *
 * Covers:
 *   - Authorization: non-admin is redirected; admin sees the page
 *   - Loading state: KpiSkeleton rendered while loading
 *   - Error state: error Alert + Retry button; clicking Retry calls refresh()
 *   - Empty state: "No jobs in the queue yet" message when live.total=0 and history.overall.samples=0
 *   - Loaded state: KPI cards, per-type table rows with ETC/avg duration
 *   - ETA basis='none': "Not enough history" displayed in ETC KPI card
 *   - "Refresh now" button is present and clickable
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { render, mockAdminUser, mockUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted before component imports)
// ---------------------------------------------------------------------------

// Mock usePermissions to control admin gate
vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

// Mock useJobInsights to control hook state
vi.mock('../../hooks/useJobInsights', () => ({
  useJobInsights: vi.fn(),
}));

// Mock KpiSkeleton so we can detect it easily
vi.mock('../../components/insights/KpiSkeleton', () => ({
  KpiSkeleton: () => <div data-testid="kpi-skeleton">Loading…</div>,
}));

// Mock ProportionBar to avoid canvas rendering
vi.mock('../../components/insights/ProportionBar', () => ({
  ProportionBar: ({ caption }: { caption: string }) => (
    <div data-testid="proportion-bar">{caption}</div>
  ),
}));

// Mock FreshnessPill (uses Date math which is fine, but keep it simple)
vi.mock('../../components/insights/FreshnessPill', () => ({
  FreshnessPill: ({ computedAt }: { computedAt: string }) => (
    <div data-testid="freshness-pill">{computedAt}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import JobInsightsPage from '../../pages/Admin/JobInsightsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useJobInsights } from '../../hooks/useJobInsights';
import type { JobInsights } from '../../services/jobInsights';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseJobInsights = vi.mocked(useJobInsights);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleInsights: JobInsights = {
  computedAt: '2025-06-20T10:00:00.000Z',
  windowDays: 7,
  concurrency: 1,
  live: {
    total: 15,
    byStatus: { pending: 5, running: 2, succeeded: 7, failed: 1 },
    pending: 5,
    running: 2,
    failed: 1,
    scheduled: 3,
    rateLimited: 0,
    retried: 3,
    byType: [
      { type: 'face_detection', pending: 5, running: 2, succeeded: 7, failed: 1, total: 15 },
    ],
  },
  history: {
    overall: { samples: 100, avgMs: 2000, p50Ms: 1800, p95Ms: 4500, throughputPerMin: 1.5 },
    byType: [
      { type: 'face_detection', samples: 100, avgMs: 2000, p50Ms: 1800, p95Ms: 4500, throughputPerMin: 1.5 },
    ],
  },
  eta: {
    totalRemaining: 7,
    etaMs: 14000,
    basis: 'live',
    perType: [
      { type: 'face_detection', remaining: 7, avgMs: 2000, etcMs: 14000 },
    ],
  },
};

const emptyInsights: JobInsights = {
  ...sampleInsights,
  live: {
    ...sampleInsights.live,
    total: 0,
    byStatus: { pending: 0, running: 0, succeeded: 0, failed: 0 },
    pending: 0,
    running: 0,
    failed: 0,
    scheduled: 0,
    rateLimited: 0,
    retried: 0,
    byType: [],
  },
  history: {
    overall: { samples: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, throughputPerMin: 0 },
    byType: [],
  },
  eta: { totalRemaining: 0, etaMs: 0, basis: 'live', perType: [] },
};

function makeAdminPermissions() {
  return {
    isAdmin: true,
    permissions: new Set(['jobs:read']),
    roles: new Set(['admin']),
    hasPermission: vi.fn().mockReturnValue(true),
    hasAnyPermission: vi.fn().mockReturnValue(true),
    hasAllPermissions: vi.fn().mockReturnValue(true),
    hasRole: vi.fn().mockReturnValue(true),
    hasAnyRole: vi.fn().mockReturnValue(true),
  };
}

function makeViewerPermissions() {
  return {
    isAdmin: false,
    permissions: new Set<string>(),
    roles: new Set(['viewer']),
    hasPermission: vi.fn().mockReturnValue(false),
    hasAnyPermission: vi.fn().mockReturnValue(false),
    hasAllPermissions: vi.fn().mockReturnValue(false),
    hasRole: vi.fn().mockReturnValue(false),
    hasAnyRole: vi.fn().mockReturnValue(false),
  };
}

function makeHookReturn(
  overrides: Partial<ReturnType<typeof useJobInsights>> = {},
): ReturnType<typeof useJobInsights> {
  return {
    data: sampleInsights,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobInsightsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(makeAdminPermissions());
    mockUseJobInsights.mockReturnValue(makeHookReturn());
  });

  // =========================================================================
  // Authorization
  // =========================================================================

  describe('authorization', () => {
    it('redirects non-admin users (does not render page content)', () => {
      mockUsePermissions.mockReturnValue(makeViewerPermissions());

      render(<JobInsightsPage />, { wrapperOptions: { user: mockUser } });

      expect(screen.queryByText(/Job Queue Insights/i)).toBeNull();
    });

    it('renders the page heading for admin users', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Job Queue Insights')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Loading state
  // =========================================================================

  describe('loading state', () => {
    it('renders KpiSkeleton while loading', () => {
      mockUseJobInsights.mockReturnValue(makeHookReturn({ loading: true, data: null }));

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByTestId('kpi-skeleton')).toBeInTheDocument();
    });

    it('does not render KPI cards while loading', () => {
      mockUseJobInsights.mockReturnValue(makeHookReturn({ loading: true, data: null }));

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByText('Pending')).toBeNull();
    });

    it('does not show empty state while loading', () => {
      mockUseJobInsights.mockReturnValue(makeHookReturn({ loading: true, data: null }));

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByText(/No jobs in the queue yet/i)).toBeNull();
    });
  });

  // =========================================================================
  // Error state
  // =========================================================================

  describe('error state', () => {
    it('renders the error message in an Alert', () => {
      mockUseJobInsights.mockReturnValue(
        makeHookReturn({ error: 'Failed to fetch insights', data: null }),
      );

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Failed to fetch insights')).toBeInTheDocument();
    });

    it('renders a Retry button in the error Alert', () => {
      mockUseJobInsights.mockReturnValue(
        makeHookReturn({ error: 'Network error', data: null }),
      );

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
    });

    it('calls refresh() when the Retry button is clicked', async () => {
      const mockRefresh = vi.fn().mockResolvedValue(undefined);
      mockUseJobInsights.mockReturnValue(
        makeHookReturn({ error: 'Network error', data: null, refresh: mockRefresh }),
      );

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      fireEvent.click(screen.getByRole('button', { name: /Retry/i }));

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
    });
  });

  // =========================================================================
  // Empty state
  // =========================================================================

  describe('empty state', () => {
    it('shows "No jobs in the queue yet" when live.total=0 and overall.samples=0', () => {
      mockUseJobInsights.mockReturnValue(makeHookReturn({ data: emptyInsights }));

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/No jobs in the queue yet/i)).toBeInTheDocument();
    });

    it('shows empty state description text', () => {
      mockUseJobInsights.mockReturnValue(makeHookReturn({ data: emptyInsights }));

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        screen.getByText(/Job queue insights will appear here once enrichment jobs have been processed/i),
      ).toBeInTheDocument();
    });

    it('does not render KPI card labels in empty state', () => {
      mockUseJobInsights.mockReturnValue(makeHookReturn({ data: emptyInsights }));

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByText('Pending')).toBeNull();
      expect(screen.queryByText('Running')).toBeNull();
    });

    it('shows empty state when data is null (not yet loaded)', () => {
      mockUseJobInsights.mockReturnValue(makeHookReturn({ data: null, loading: false }));

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/No jobs in the queue yet/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Loaded state — KPI cards
  // =========================================================================

  describe('loaded state — KPI cards', () => {
    it('renders the ETC KPI card label', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      // "ETC" appears as both the KPI card label and the table column header
      const matches = screen.getAllByText('ETC');
      expect(matches.length).toBeGreaterThan(0);
    });

    it('renders the Avg Duration KPI card label', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      // "Avg Duration" appears as both a KPI card label and a table column header
      const matches = screen.getAllByText('Avg Duration');
      expect(matches.length).toBeGreaterThan(0);
    });

    it('renders the Pending KPI card label', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Pending')).toBeInTheDocument();
    });

    it('renders the Running KPI card label', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Running')).toBeInTheDocument();
    });

    it('renders the Failed KPI card label', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Failed')).toBeInTheDocument();
    });

    it('renders the Rate-limited KPI card label', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Rate-limited')).toBeInTheDocument();
    });

    it('renders the Backing off KPI card label', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Backing off')).toBeInTheDocument();
    });

    it('renders the Retried KPI card label', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Retried')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Loaded state — per-type table
  // =========================================================================

  describe('loaded state — per-type table', () => {
    it('renders the per-type breakdown section heading', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/Per-type breakdown/i)).toBeInTheDocument();
    });

    it('renders a table row for face_detection type', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('face_detection')).toBeInTheDocument();
    });

    it('renders Type column header', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('columnheader', { name: /Type/i })).toBeInTheDocument();
    });

    it('renders Queued column header', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('columnheader', { name: /Queued/i })).toBeInTheDocument();
    });

    it('renders ETC column header', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('columnheader', { name: /ETC/i })).toBeInTheDocument();
    });

    it('renders Avg Duration column header', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      // The table header says "Avg Duration"
      expect(screen.getByRole('columnheader', { name: /Avg Duration/i })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // ETA basis='none' — "Not enough history"
  // =========================================================================

  describe('ETA basis=none', () => {
    it('renders "Not enough history" in ETC card when basis=none', () => {
      const noHistoryInsights: JobInsights = {
        ...sampleInsights,
        eta: {
          totalRemaining: 5,
          etaMs: null,
          basis: 'none',
          perType: [{ type: 'face_detection', remaining: 5, avgMs: null, etcMs: null }],
        },
      };
      mockUseJobInsights.mockReturnValue(makeHookReturn({ data: noHistoryInsights }));

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Not enough history')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Refresh button
  // =========================================================================

  describe('Refresh button', () => {
    it('renders "Refresh now" button', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /Refresh now/i })).toBeInTheDocument();
    });

    it('disables the Refresh button while loading', () => {
      mockUseJobInsights.mockReturnValue(makeHookReturn({ loading: true, data: null }));

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      const btn = screen.getByRole('button', { name: /Refresh now/i });
      expect(btn).toBeDisabled();
    });

    it('calls refresh() when Refresh now is clicked', async () => {
      const mockRefresh = vi.fn().mockResolvedValue(undefined);
      mockUseJobInsights.mockReturnValue(makeHookReturn({ refresh: mockRefresh }));

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      fireEvent.click(screen.getByRole('button', { name: /Refresh now/i }));

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
    });
  });

  // =========================================================================
  // FreshnessPill shows when data is present
  // =========================================================================

  describe('FreshnessPill', () => {
    it('renders the FreshnessPill with computedAt when data is loaded', () => {
      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByTestId('freshness-pill')).toBeInTheDocument();
    });

    it('does not render FreshnessPill when data is null', () => {
      mockUseJobInsights.mockReturnValue(makeHookReturn({ data: null, loading: true }));

      render(<JobInsightsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByTestId('freshness-pill')).toBeNull();
    });
  });
});

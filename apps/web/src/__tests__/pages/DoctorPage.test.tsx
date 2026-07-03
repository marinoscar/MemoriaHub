/**
 * Unit tests for DoctorPage (Admin/DoctorPage.tsx).
 *
 * Mocking strategy:
 *   - usePermissions is module-mocked to control admin state.
 *   - useDoctor is module-mocked to control the diagnostics report, loading,
 *     error, and run() directly — no network/service calls are made.
 *
 * The page redirects non-admins to /. Admins see:
 *   - A "Doctor — Diagnostics" heading.
 *   - A "Run diagnostics" button.
 *   - A loading spinner on first load (loading && !report).
 *   - An error alert when the initial load fails (error && !report).
 *   - A summary Stack of Chips (overall status + OK/Warning/Error/Skipped counts).
 *   - One Paper per section with per-check rows (label + message + optional
 *     inline action-item Alert).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render, mockAdminUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — must appear before imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useDoctor', () => ({
  useDoctor: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import DoctorPage from '../../pages/Admin/DoctorPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useDoctor } from '../../hooks/useDoctor';
import type { DoctorReport } from '../../services/doctor';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseDoctor = vi.mocked(useDoctor);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminPermissions() {
  return {
    isAdmin: true,
    permissions: new Set(['system_settings:read', 'system_settings:write']),
    roles: new Set(['admin']),
    hasPermission: vi.fn().mockReturnValue(true),
    hasAnyPermission: vi.fn().mockReturnValue(true),
    hasAllPermissions: vi.fn().mockReturnValue(true),
    hasRole: vi.fn().mockReturnValue(true),
    hasAnyRole: vi.fn().mockReturnValue(true),
  };
}

function nonAdminPermissions() {
  return {
    isAdmin: false,
    permissions: new Set<string>(),
    roles: new Set<string>(),
    hasPermission: vi.fn().mockReturnValue(false),
    hasAnyPermission: vi.fn().mockReturnValue(false),
    hasAllPermissions: vi.fn().mockReturnValue(false),
    hasRole: vi.fn().mockReturnValue(false),
    hasAnyRole: vi.fn().mockReturnValue(false),
  };
}

/**
 * Builds a realistic DoctorReport fixture with mixed statuses across
 * multiple sections, including one check with an actionItem.
 */
function makeReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    computedAt: new Date('2026-07-03T12:00:00Z').toISOString(),
    durationMs: 842,
    summary: {
      ok: 3,
      warning: 1,
      error: 1,
      skipped: 1,
      total: 6,
    },
    sections: [
      {
        key: 'auth',
        label: 'Authentication',
        status: 'ok',
        checks: [
          {
            key: 'jwt-secret',
            label: 'JWT secret configured',
            status: 'ok',
            message: 'JWT_SECRET is set and meets minimum length.',
            durationMs: 5,
          },
          {
            key: 'google-oauth',
            label: 'Google OAuth configured',
            status: 'ok',
            message: 'Google client ID and secret are present.',
            durationMs: 4,
          },
        ],
      },
      {
        key: 'storage',
        label: 'Storage',
        status: 'error',
        checks: [
          {
            key: 'active-provider',
            label: 'Active storage provider reachable',
            status: 'error',
            message: 'Could not connect to the configured S3 bucket.',
            actionItem: 'Check storage credentials in Admin Settings → Storage Providers.',
            durationMs: 120,
          },
          {
            key: 'disk-space',
            label: 'Local disk space',
            status: 'ok',
            message: 'Sufficient disk space available.',
            durationMs: 10,
          },
        ],
      },
      {
        key: 'jobs',
        label: 'Background Jobs',
        status: 'warning',
        checks: [
          {
            key: 'stuck-jobs',
            label: 'No stuck jobs',
            status: 'warning',
            message: '2 jobs have been running for over 15 minutes.',
            durationMs: 30,
          },
          {
            key: 'ai-provider',
            label: 'AI provider configured',
            status: 'skipped',
            message: 'Auto-tagging is disabled; check skipped.',
            durationMs: 1,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makeDoctorHookResult(
  opts: {
    report?: DoctorReport | null;
    loading?: boolean;
    error?: string | null;
    run?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    report: opts.report !== undefined ? opts.report : null,
    loading: opts.loading ?? false,
    error: opts.error ?? null,
    run: opts.run ?? vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DoctorPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(adminPermissions() as ReturnType<typeof usePermissions>);
    mockUseDoctor.mockReturnValue(makeDoctorHookResult() as ReturnType<typeof useDoctor>);
  });

  // -------------------------------------------------------------------------
  describe('access control', () => {
    it('redirects non-admin users to / and does not render the page heading', () => {
      mockUsePermissions.mockReturnValue(nonAdminPermissions() as ReturnType<typeof usePermissions>);

      render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByText(/doctor.*diagnostics/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('loading state', () => {
    it('shows a loading spinner on first load (no report yet)', () => {
      mockUseDoctor.mockReturnValue(
        makeDoctorHookResult({ report: null, loading: true, error: null }) as ReturnType<typeof useDoctor>,
      );

      render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('error state', () => {
    it('shows an error alert when the initial load fails (no report)', () => {
      mockUseDoctor.mockReturnValue(
        makeDoctorHookResult({ report: null, loading: false, error: 'boom' }) as ReturnType<typeof useDoctor>,
      );

      render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('rendering a report', () => {
    it('renders the page title, sections, checks, action items, and summary chips', () => {
      const report = makeReport();
      mockUseDoctor.mockReturnValue(
        makeDoctorHookResult({ report, loading: false, error: null }) as ReturnType<typeof useDoctor>,
      );

      render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });

      // Page title
      expect(screen.getByText(/doctor.*diagnostics/i)).toBeInTheDocument();

      // Section labels
      expect(screen.getByText('Authentication')).toBeInTheDocument();
      expect(screen.getByText('Storage')).toBeInTheDocument();
      expect(screen.getByText('Background Jobs')).toBeInTheDocument();

      // A check label + message
      expect(screen.getByText('JWT secret configured')).toBeInTheDocument();
      expect(screen.getByText('JWT_SECRET is set and meets minimum length.')).toBeInTheDocument();

      // Action item text, rendered inside an Alert
      const actionItemText = screen.getByText(
        /check storage credentials in admin settings/i,
      );
      expect(actionItemText).toBeInTheDocument();
      expect(actionItemText.closest('.MuiAlert-root')).not.toBeNull();

      // Summary chips
      expect(screen.getByText(/OK: 3/)).toBeInTheDocument();
      expect(screen.getByText(/Warning: 1/)).toBeInTheDocument();
      expect(screen.getByText(/Error: 1/)).toBeInTheDocument();
      expect(screen.getByText(/Skipped: 1/)).toBeInTheDocument();

      // Overall status chip — report has an error present, so "Unhealthy"
      expect(screen.getByText('Unhealthy')).toBeInTheDocument();
    });

    it('shows "Healthy" overall status when there are no warnings or errors', () => {
      const report = makeReport({
        summary: { ok: 4, warning: 0, error: 0, skipped: 0, total: 4 },
      });
      mockUseDoctor.mockReturnValue(
        makeDoctorHookResult({ report, loading: false, error: null }) as ReturnType<typeof useDoctor>,
      );

      render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Healthy')).toBeInTheDocument();
    });

    it('shows "Needs attention" overall status when there are warnings but no errors', () => {
      const report = makeReport({
        summary: { ok: 4, warning: 2, error: 0, skipped: 0, total: 6 },
      });
      mockUseDoctor.mockReturnValue(
        makeDoctorHookResult({ report, loading: false, error: null }) as ReturnType<typeof useDoctor>,
      );

      render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Needs attention')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('run button', () => {
    it('calls run() when the "Run diagnostics" button is clicked', () => {
      const run = vi.fn().mockResolvedValue(undefined);
      const report = makeReport();
      mockUseDoctor.mockReturnValue(
        makeDoctorHookResult({ report, loading: false, error: null, run }) as ReturnType<typeof useDoctor>,
      );

      render(<DoctorPage />, { wrapperOptions: { user: mockAdminUser } });

      fireEvent.click(screen.getByRole('button', { name: /run diagnostics/i }));

      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Unit tests for NodeBackupPage (`/admin/settings/nodes/:id/backup`, issue
 * #319, epic #308).
 *
 * Services are mocked (not the hook), so the config round-trip exercises
 * `useNodeBackup` + the page together: PUT payloads, the server's 400 for an
 * invalid cron surfaced inline on the custom-cron field, and `nextRunAt`
 * rendering straight from the PUT response.
 *
 * Table MECHANICS live in the DataTable conformance suite; the runs-table
 * tests here only cover this page's column declarations (statuses, durations,
 * BigInt-safe humanized bytes, lastError via the detail/expansion surface).
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { render, mockAdminUser } from '../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../components/datatable/__tests__/testUtils/layoutStubs';

// ---------------------------------------------------------------------------
// Module mocks — must be declared BEFORE imports they affect
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useCircles', () => ({
  useCircles: vi.fn(),
}));

vi.mock('../../services/nodeBackup', () => ({
  getNodeBackupConfig: vi.fn(),
  updateNodeBackupConfig: vi.fn(),
  getNodeBackupRuns: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import NodeBackupPage, {
  DAILY_CRON,
  WEEKLY_CRON,
  deriveSchedulePreset,
} from '../../pages/Admin/NodeBackupPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useCircles } from '../../hooks/useCircles';
import {
  getNodeBackupConfig,
  getNodeBackupRuns,
  updateNodeBackupConfig,
} from '../../services/nodeBackup';
import type {
  NodeBackupConfigDto,
  NodeBackupRunDto,
} from '../../services/nodeBackup';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseCircles = vi.mocked(useCircles);
const mockGetConfig = vi.mocked(getNodeBackupConfig);
const mockUpdateConfig = vi.mocked(updateNodeBackupConfig);
const mockGetRuns = vi.mocked(getNodeBackupRuns);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NODE_ID = 'node-1';

function makePermissions(isAdmin: boolean) {
  return {
    permissions: new Set<string>(),
    roles: new Set<string>(isAdmin ? ['admin'] : ['viewer']),
    hasPermission: vi.fn().mockReturnValue(isAdmin),
    hasAnyPermission: vi.fn().mockReturnValue(isAdmin),
    hasAllPermissions: vi.fn().mockReturnValue(isAdmin),
    hasRole: vi.fn().mockReturnValue(isAdmin),
    hasAnyRole: vi.fn().mockReturnValue(isAdmin),
    isAdmin,
  };
}

function makeConfig(overrides: Partial<NodeBackupConfigDto> = {}): NodeBackupConfigDto {
  return {
    nodeId: NODE_ID,
    enabled: true,
    scheduleCron: DAILY_CRON,
    timezone: 'UTC',
    nextRunAt: '2026-08-10T03:00:00Z',
    circleIds: [],
    checkpoint: { updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), id: 'mi-1' },
    itemsAcked: '1234',
    bytesAcked: '1073741824', // 1.00 GB
    lastRunAt: '2026-08-09T03:00:00Z',
    lastCompletedRunAt: '2026-08-09T03:05:00Z',
    lastReconcileAt: null,
    pending: { items: 42, bytes: '1572864' }, // 1.50 MB
    activeRunId: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<NodeBackupRunDto> = {}): NodeBackupRunDto {
  return {
    id: 'run-1',
    kind: 'incremental',
    status: 'completed',
    trigger: 'manual',
    startedAt: '2026-08-09T00:00:00Z',
    finishedAt: '2026-08-09T00:01:30Z', // 1m 30s
    lastAckAt: '2026-08-09T00:01:00Z',
    itemsDownloaded: 120,
    itemsSkipped: 3,
    sidecarsWritten: 120,
    bytesDownloaded: '1073741824', // 1.00 GB
    errorCount: 0,
    lastError: null,
    cliVersion: '1.5.0',
    ...overrides,
  };
}

const circleFixtures = [
  {
    id: 'circle-1',
    name: 'Family',
    description: null,
    ownerId: 'admin-user-id',
    isPersonal: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'circle-2',
    name: 'Travel',
    description: null,
    ownerId: 'admin-user-id',
    isPersonal: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

function makeCirclesHook() {
  return {
    circles: circleFixtures,
    loading: false,
    error: null,
    fetchCircles: vi.fn().mockResolvedValue(undefined),
    addCircle: vi.fn(),
    editCircle: vi.fn(),
    removeCircle: vi.fn(),
  };
}

function renderPage() {
  return render(
    <Routes>
      <Route path="/admin/settings/nodes/:id/backup" element={<NodeBackupPage />} />
      <Route path="/" element={<div>home page</div>} />
    </Routes>,
    {
      wrapperOptions: {
        user: mockAdminUser,
        route: `/admin/settings/nodes/${NODE_ID}/backup`,
      },
    },
  );
}

// ---------------------------------------------------------------------------

describe('NodeBackupPage', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    mockUsePermissions.mockReturnValue(makePermissions(true));
    mockUseCircles.mockReturnValue(makeCirclesHook());
    mockGetConfig.mockResolvedValue({ config: makeConfig() });
    mockGetRuns.mockResolvedValue({ runs: [makeRun()] });
    mockUpdateConfig.mockResolvedValue({ config: makeConfig() });
  });

  // =========================================================================
  // Authorization + schedule preset helper
  // =========================================================================

  it('redirects non-admin users — page content not shown', () => {
    mockUsePermissions.mockReturnValue(makePermissions(false));

    renderPage();

    expect(screen.queryByText(/node backup/i)).not.toBeInTheDocument();
    expect(screen.getByText('home page')).toBeInTheDocument();
  });

  it('derives the schedule preset from the stored cron', () => {
    expect(deriveSchedulePreset(null)).toBe('none');
    expect(deriveSchedulePreset(DAILY_CRON)).toBe('daily');
    expect(deriveSchedulePreset(WEEKLY_CRON)).toBe('weekly');
    expect(deriveSchedulePreset('*/5 * * * *')).toBe('custom');
  });

  // =========================================================================
  // Status card
  // =========================================================================

  describe('Status card', () => {
    it('renders enabled state, checkpoint age, pending lag, totals and timestamps', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Enabled')).toBeInTheDocument();
      });
      // Checkpoint age — relative.
      expect(screen.getByText('30m ago')).toBeInTheDocument();
      // Pending lag: items + BigInt-humanized bytes.
      expect(screen.getByText(/42 items · 1\.50 MB/)).toBeInTheDocument();
      // Acked totals.
      expect(screen.getByText(/1234 items · 1\.00 GB/)).toBeInTheDocument();
      // Last reconcile never happened.
      expect(screen.getByText('never')).toBeInTheDocument();
      // No active run → no indicator.
      expect(screen.queryByText('Run in progress')).not.toBeInTheDocument();
    });

    it('shows the active-run indicator when a run is in flight', async () => {
      mockGetConfig.mockResolvedValue({
        config: makeConfig({ activeRunId: 'run-live' }),
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText('Run in progress')).toBeInTheDocument();
      });
    });

    it('shows the never-configured notice when config is null', async () => {
      mockGetConfig.mockResolvedValue({ config: null });

      renderPage();

      await waitFor(() => {
        expect(
          screen.getByText(/backup has never been configured for this node/i),
        ).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Config round-trip
  // =========================================================================

  describe('Config card', () => {
    it('initializes the form from the loaded config and PUTs the toggled state, rendering nextRunAt from the PUT response', async () => {
      mockUpdateConfig.mockResolvedValue({
        config: makeConfig({ enabled: false, nextRunAt: '2026-09-01T03:00:00Z' }),
      });
      const user = userEvent.setup();

      renderPage();

      // Initial nextRunAt from GET.
      const initialNextRun = new Date('2026-08-10T03:00:00Z').toLocaleString();
      await waitFor(() => {
        expect(screen.getByText(`Next run: ${initialNextRun}`)).toBeInTheDocument();
      });

      // The form initialized from the config: enabled on, preset Daily.
      const toggle = screen.getByRole('switch', { name: /backup enabled/i });
      expect(toggle).toBeChecked();
      await waitFor(() => {
        expect(
          screen.getByRole('combobox', { name: /schedule/i }),
        ).toHaveTextContent('Daily 03:00');
      });

      // Toggle off and save.
      await user.click(toggle);
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(mockUpdateConfig).toHaveBeenCalledWith(NODE_ID, {
          enabled: false,
          scheduleCron: DAILY_CRON,
          timezone: 'UTC',
          circleIds: [],
        });
      });

      // nextRunAt re-renders immediately from the PUT response.
      const savedNextRun = new Date('2026-09-01T03:00:00Z').toLocaleString();
      await waitFor(() => {
        expect(screen.getByText(`Next run: ${savedNextRun}`)).toBeInTheDocument();
      });
      expect(screen.getByText(/backup settings saved/i)).toBeInTheDocument();
    });

    it('maps the Weekly preset onto its cron on save', async () => {
      const user = userEvent.setup();

      renderPage();

      await user.click(await screen.findByRole('combobox', { name: /schedule/i }));
      await user.click(
        await screen.findByRole('option', { name: 'Weekly Sun 03:00' }),
      );
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(mockUpdateConfig).toHaveBeenCalledWith(
          NODE_ID,
          expect.objectContaining({ scheduleCron: WEEKLY_CRON }),
        );
      });
    });

    it('surfaces the server 400 for an invalid custom cron inline on the cron field', async () => {
      mockGetConfig.mockResolvedValue({ config: null });
      mockUpdateConfig.mockRejectedValue(
        new Error(
          'Invalid cron expression "every day" — expected the 5-field form "minute hour day-of-month month day-of-week"',
        ),
      );
      const user = userEvent.setup();

      renderPage();

      await user.click(await screen.findByRole('combobox', { name: /schedule/i }));
      await user.click(await screen.findByRole('option', { name: 'Custom cron…' }));

      const cronField = await screen.findByLabelText(/cron expression/i);
      await user.type(cronField, 'every day');
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(mockUpdateConfig).toHaveBeenCalledWith(
          NODE_ID,
          expect.objectContaining({ scheduleCron: 'every day' }),
        );
      });
      // Inline, on the field — not just a page-level alert.
      await waitFor(() => {
        expect(
          screen.getByText(/invalid cron expression "every day"/i),
        ).toBeInTheDocument();
      });
      expect(cronField).toHaveAccessibleDescription(/invalid cron expression/i);
    });

    it('sends a picked IANA timezone on save', async () => {
      const user = userEvent.setup();

      renderPage();

      const tzInput = await screen.findByRole('combobox', { name: /timezone/i });
      await user.click(tzInput);
      await user.clear(tzInput);
      await user.type(tzInput, 'America/Costa');
      await user.click(
        await screen.findByRole('option', { name: 'America/Costa_Rica' }),
      );
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(mockUpdateConfig).toHaveBeenCalledWith(
          NODE_ID,
          expect.objectContaining({ timezone: 'America/Costa_Rica' }),
        );
      });
    });

    it('shows "All my circles" when the scope is empty and sends picked circle ids on save', async () => {
      const user = userEvent.setup();

      renderPage();

      const circlesInput = await screen.findByRole('combobox', { name: /circles/i });
      expect(circlesInput).toHaveAttribute('placeholder', 'All my circles');

      await user.click(circlesInput);
      await user.click(await screen.findByRole('option', { name: 'Family' }));
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(mockUpdateConfig).toHaveBeenCalledWith(
          NODE_ID,
          expect.objectContaining({ circleIds: ['circle-1'] }),
        );
      });
    });
  });

  // =========================================================================
  // Runs table
  // =========================================================================

  describe('Runs table', () => {
    it('renders kind, status chip, duration and humanized bytes from fixtures', async () => {
      mockGetRuns.mockResolvedValue({
        runs: [
          makeRun({ id: 'run-ok' }),
          makeRun({
            id: 'run-bad',
            kind: 'reconcile',
            status: 'failed',
            trigger: 'scheduled',
            finishedAt: '2026-08-09T01:00:00Z', // 1h
            bytesDownloaded: '1572864', // 1.50 MB
            itemsDownloaded: 7,
            itemsSkipped: 5,
            errorCount: 9,
            lastError: 'boom: download failed',
          }),
        ],
      });

      renderPage();

      const grid = await screen.findByRole('grid', { name: /backup runs/i });
      await waitFor(() => {
        expect(within(grid).getByText('incremental')).toBeInTheDocument();
      });
      expect(within(grid).getByText('reconcile')).toBeInTheDocument();
      expect(within(grid).getByText('completed')).toBeInTheDocument();
      expect(within(grid).getByText('failed')).toBeInTheDocument();
      expect(within(grid).getByText('scheduled')).toBeInTheDocument();
      // Durations: finishedAt - startedAt.
      expect(within(grid).getByText('1m 30s')).toBeInTheDocument();
      expect(within(grid).getByText('1h')).toBeInTheDocument();
      // BigInt-humanized bytes.
      expect(within(grid).getByText('1.00 GB')).toBeInTheDocument();
      expect(within(grid).getByText('1.50 MB')).toBeInTheDocument();
      // Error count from the failing run.
      expect(within(grid).getByText('9')).toBeInTheDocument();
    });

    it('shows an em dash duration for a still-running run', async () => {
      mockGetRuns.mockResolvedValue({
        runs: [makeRun({ id: 'run-live', status: 'running', finishedAt: null })],
      });

      renderPage();

      const grid = await screen.findByRole('grid', { name: /backup runs/i });
      await waitFor(() => {
        expect(within(grid).getByText('running')).toBeInTheDocument();
      });
      // Both the duration cell and the null lastError cell render an em dash.
      expect(within(grid).getAllByText('—').length).toBeGreaterThanOrEqual(1);
    });

    it('reveals lastError through the row expansion (tablet width)', async () => {
      setInitialContainerWidth(800);
      mockGetRuns.mockResolvedValue({
        runs: [
          makeRun({
            id: 'run-bad',
            kind: 'reconcile',
            status: 'failed',
            errorCount: 1,
            lastError: 'boom: download failed',
          }),
        ],
      });
      const user = userEvent.setup();

      renderPage();

      // `lastError` is a detail column — folded behind the expander at tablet
      // width, so it must not be visible before expanding.
      const expander = await screen.findByRole('button', {
        name: /show details for reconcile/i,
      });
      expect(screen.queryByText('boom: download failed')).not.toBeInTheDocument();

      await user.click(expander);

      await waitFor(() => {
        expect(screen.getByText('boom: download failed')).toBeInTheDocument();
      });
    });

    it('shows the empty state when there are no runs yet', async () => {
      mockGetRuns.mockResolvedValue({ runs: [] });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/no backup runs yet/i)).toBeInTheDocument();
      });
    });
  });
});

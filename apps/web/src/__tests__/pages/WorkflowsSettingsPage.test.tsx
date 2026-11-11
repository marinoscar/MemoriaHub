/**
 * Unit tests for WorkflowsSettingsPage (issue #143).
 *
 * Mocking strategy:
 *   - usePermissions is module-mocked to control admin state and the two
 *     distinct permissions the page checks (system_settings:write for
 *     canManage, jobs:write for canCancel).
 *   - useSystemSettings is module-mocked to control the workflows.* settings
 *     and capture updateSettings calls.
 *   - services/adminWorkflows is module-mocked to prevent real API calls and
 *     to drive the KPI strip / oversight table / runs drawer content.
 *
 * The page redirects non-admins to /. Admins see the feature/trigger
 * toggles, engine-limit fields, the hard-delete danger card, a KPI strip, and
 * the cross-circle oversight table with disable / view-runs / cancel row
 * actions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

// The page is the packaged one: its clients go through the app's `api` (the host's transport), which
// the tests stub; the principal's roles and permissions come from the user the wrapper signs in.
import { WorkflowsSettingsPage } from '@marinoscar/memoriahub-web/workflows/ui';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { api } from '../../services/api';

const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockGetStats = vi.fn();
const mockListWorkflows = vi.fn();
const mockListRuns = vi.fn();
const mockDisable = vi.fn();
const mockCancelRun = vi.fn();

const query = (endpoint: string) => {
  const out: Record<string, string | number> = {};
  new URLSearchParams(endpoint.split('?')[1] ?? '').forEach((v, k) => {
    out[k] = /^\d+$/.test(v) ? Number(v) : v;
  });
  return out;
};

const adminUser = {
  ...mockAdminUser,
  permissions: ['system_settings:read', 'system_settings:write', 'jobs:read', 'jobs:write'],
} as typeof mockAdminUser;
const viewerUser = { ...mockAdminUser, roles: [{ name: 'viewer' }], permissions: [] } as typeof mockAdminUser;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSystemSettingsMock(overrides: Record<string, unknown> = {}) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  return {
    settings: {
      features: { autoTagging: false, faceRecognition: false, burstDetection: false, workflows: false },
      workflows: {
        maxItemsPerRun: 10000,
        batchSize: 200,
        maxConcurrentRuns: 2,
        requirePreview: true,
        allowHardDelete: false,
        maxWorkflowsPerCircle: 20,
        previewTtlHours: 24,
        runHistoryRetentionDays: 30,
        triggers: { onEnrichment: true, scheduled: true },
        scheduleMinIntervalMinutes: 60,
        ...(overrides.workflows as Record<string, unknown> | undefined),
      },
      ui: { allowUserThemeOverride: true },
      updatedAt: new Date().toISOString(),
      updatedBy: null,
      version: 1,
      ...overrides,
    },
    isLoading: false,
    isSaving: false,
    error: null,
    updateSettings,
    replaceSettings: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

function makeWorkflowItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'workflow-1',
    circle: { id: 'circle-1', name: 'Family circle' },
    name: 'Screenshot cleanup',
    subjectType: 'media_item',
    trigger: 'manual',
    enabled: true,
    cronExpression: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: { id: 'user-1', email: 'admin@example.com', displayName: 'Admin' },
    lastRun: null,
    totals: { runs: 0, matched: 0, actioned: 0 },
    ...overrides,
  };
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    workflowId: 'workflow-1',
    workflow: { id: 'workflow-1', name: 'Screenshot cleanup' },
    circleId: 'circle-1',
    circle: { id: 'circle-1', name: 'Family circle' },
    status: 'running',
    triggerType: 'manual',
    matchedCount: 100,
    truncated: false,
    processedCount: 40,
    succeededCount: 30,
    failedCount: 10,
    skippedCount: 0,
    startedById: 'user-1',
    approvedById: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvedAt: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: null,
    ...overrides,
  };
}

/**
 * Open a workflow row's overflow menu.
 *
 * Post-#261 the oversight table's row actions live in the shared DataTable's
 * `MoreVert` menu, named after the row's first `primary` column value
 * (docs/specs/datatable.md §17.6) — not as two bare buttons in a trailing cell.
 */
async function openWorkflowRowMenu(
  user: ReturnType<typeof userEvent.setup>,
  rowLabel = 'Screenshot cleanup',
) {
  await user.click(await screen.findByRole('button', { name: `Row actions for ${rowLabel}` }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowsSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api, 'get').mockImplementation(async (endpoint: string) => {
      if (endpoint === '/admin/workflows/stats') return mockGetStats() as never;
      if (endpoint.startsWith('/admin/workflows?')) return mockListWorkflows(query(endpoint)) as never;
      if (endpoint.startsWith('/admin/workflow-runs')) return mockListRuns(query(endpoint)) as never;
      return {} as never;
    });
    vi.spyOn(api, 'post').mockImplementation(async (endpoint: string) => {
      const disable = /^\/admin\/workflows\/(.+)\/disable$/.exec(endpoint);
      if (disable) return mockDisable(disable[1]) as never;
      const cancel = /^\/admin\/workflow-runs\/(.+)\/cancel$/.exec(endpoint);
      if (cancel) return mockCancelRun(cancel[1]) as never;
      return {} as never;
    });
    mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock() as any);
    mockGetStats.mockResolvedValue({
      windowDays: 7,
      runsLast7Days: 5,
      itemsActioned: 42,
      failures: 1,
      currentlyRunning: 0,
    });
    mockListWorkflows.mockResolvedValue({
      items: [makeWorkflowItem()],
      meta: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 },
    });
    mockListRuns.mockResolvedValue({
      items: [makeRun()],
      meta: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 },
    });
    mockDisable.mockResolvedValue({ id: 'workflow-1', enabled: false });
    mockCancelRun.mockResolvedValue({ id: 'run-1', status: 'cancelled' } as any);
  });

  // -------------------------------------------------------------------------
  describe('access control', () => {
    it('redirects non-admin users', () => {
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: viewerUser } });

      expect(
        screen.queryByRole('heading', { name: /workflow automation/i }),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('loading and error states', () => {
    it('shows a loading spinner while settings are loading', () => {
      mockUseSystemSettings.mockReturnValue({
        settings: null,
        isLoading: true,
        isSaving: false,
        error: null,
        updateSettings: vi.fn(),
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      } as any);

      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows an error alert when settings fail to load', () => {
      mockUseSystemSettings.mockReturnValue({
        settings: null,
        isLoading: false,
        isSaving: false,
        error: 'Failed to load settings',
        updateSettings: vi.fn(),
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      } as any);

      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('page structure', () => {
    it('renders the page heading and back link', () => {
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      expect(screen.getByRole('heading', { name: /workflow automation/i })).toBeInTheDocument();
      expect(screen.getByText(/back to settings/i)).toBeInTheDocument();
    });

    it('fetches and renders the KPI strip', async () => {
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      await waitFor(() => expect(mockGetStats).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument());
    });
  });

  // -------------------------------------------------------------------------
  describe('global feature toggle', () => {
    it('switch reflects features.workflows=false', () => {
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      const label = screen.getByText(/enable workflow automation globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(switchEl?.checked).toBe(false);
    });

    it('calls updateSettings with features.workflows=true when toggled on', async () => {
      const mock = makeSystemSettingsMock();
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      const label = screen.getByText(/enable workflow automation globally/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            features: expect.objectContaining({ workflows: true }),
          }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('triggers & approval toggles', () => {
    it('toggling "On new media" calls updateSettings with workflows.triggers.onEnrichment', async () => {
      const mock = makeSystemSettingsMock({ workflows: { triggers: { onEnrichment: true, scheduled: true } } });
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      const label = screen.getByText(/on new media/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            workflows: expect.objectContaining({ triggers: { onEnrichment: false } }),
          }),
        );
      });
    });

    it('toggling "Scheduled runs" calls updateSettings with workflows.triggers.scheduled', async () => {
      const mock = makeSystemSettingsMock();
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      const label = screen.getByText(/scheduled runs/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            workflows: expect.objectContaining({ triggers: { scheduled: false } }),
          }),
        );
      });
    });

    it('toggling "Require preview approval" calls updateSettings with workflows.requirePreview', async () => {
      const mock = makeSystemSettingsMock();
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      const label = screen.getByText(/require preview approval/i);
      const switchEl = label
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLElement;
      await user.click(switchEl);

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            workflows: expect.objectContaining({ requirePreview: false }),
          }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('engine limits', () => {
    it('pre-fills the limit fields from settings', () => {
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      expect((screen.getByLabelText(/max items per run/i) as HTMLInputElement).value).toBe('10000');
      expect((screen.getByLabelText(/batch size/i) as HTMLInputElement).value).toBe('200');
      expect((screen.getByLabelText(/max concurrent runs/i) as HTMLInputElement).value).toBe('2');
    });

    it('saves all seven limit fields when "Save Limits" is clicked', async () => {
      const mock = makeSystemSettingsMock();
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      await user.click(screen.getByRole('button', { name: /save limits/i }));

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith({
          workflows: {
            maxItemsPerRun: 10000,
            batchSize: 200,
            maxConcurrentRuns: 2,
            maxWorkflowsPerCircle: 20,
            previewTtlHours: 24,
            runHistoryRetentionDays: 30,
            scheduleMinIntervalMinutes: 60,
          },
        });
      });
    });

    it('shows a success message after saving limits', async () => {
      const mock = makeSystemSettingsMock();
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      await user.click(screen.getByRole('button', { name: /save limits/i }));

      await waitFor(() => {
        expect(screen.getByText(/workflow limits saved/i)).toBeInTheDocument();
      });
    });

    it('shows an error snackbar when saving limits fails', async () => {
      const mock = makeSystemSettingsMock();
      mock.updateSettings.mockRejectedValue(new Error('Save failed'));
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      await user.click(screen.getByRole('button', { name: /save limits/i }));

      await waitFor(() => {
        expect(screen.getByText(/save failed/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('danger card wiring', () => {
    it('renders the danger card reflecting allowHardDelete=false', () => {
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      expect(screen.getByText(/danger zone/i)).toBeInTheDocument();
      const toggle = screen.getByLabelText(/allow the hard-delete workflow action/i) as HTMLInputElement;
      expect(toggle.checked).toBe(false);
    });

    it('unlocking hard delete calls updateSettings and shows the unlocked confirmation message', async () => {
      const mock = makeSystemSettingsMock();
      mockUseSystemSettings.mockReturnValue(mock as any);

      const user = userEvent.setup();
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      const toggle = screen.getByLabelText(/allow the hard-delete workflow action/i);
      await user.click(toggle);

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            workflows: expect.objectContaining({ allowHardDelete: true }),
          }),
        );
      });
      await waitFor(() => {
        expect(screen.getByText(/hard delete unlocked/i)).toBeInTheDocument();
      });
    });

    it('shows the danger-zone warning Alert only once allowHardDelete is true', () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({ workflows: { allowHardDelete: true } }) as any,
      );

      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      const alerts = screen.getAllByRole('alert');
      expect(
        alerts.some((el) => /currently\s*unlocked/i.test(el.textContent ?? '')),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('oversight table', () => {
    it('fetches and renders workflows on mount', async () => {
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      await waitFor(() => {
        expect(mockListWorkflows).toHaveBeenCalledWith({ page: 1, pageSize: 25 });
      });
      await waitFor(() => {
        expect(screen.getByText('Screenshot cleanup')).toBeInTheDocument();
      });
    });

    it('disabling a workflow opens a confirm dialog, then calls disableAdminWorkflow on confirm', async () => {
      const user = userEvent.setup();
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      await waitFor(() => expect(screen.getByText('Screenshot cleanup')).toBeInTheDocument());

      await openWorkflowRowMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /^disable$/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/disable workflow\?/i)).toBeInTheDocument();
      expect(mockDisable).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: /^disable$/i }));

      await waitFor(() => expect(mockDisable).toHaveBeenCalledWith('workflow-1'));
      await waitFor(() => {
        expect(screen.getByText(/disabled "screenshot cleanup"/i)).toBeInTheDocument();
      });
    });

    it('cancelling the disable confirm dialog does not call disableAdminWorkflow', async () => {
      const user = userEvent.setup();
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      await waitFor(() => expect(screen.getByText('Screenshot cleanup')).toBeInTheDocument());

      await openWorkflowRowMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /^disable$/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

      expect(mockDisable).not.toHaveBeenCalled();
    });

    it('clicking "Runs" opens the runs drawer and fetches runs for that workflow', async () => {
      const user = userEvent.setup();
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      await waitFor(() => expect(screen.getByText('Screenshot cleanup')).toBeInTheDocument());

      await openWorkflowRowMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /^runs$/i }));

      await waitFor(() => {
        expect(mockListRuns).toHaveBeenCalledWith(
          expect.objectContaining({ workflowId: 'workflow-1' }),
        );
      });
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /run history/i })).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('cancel-run flow (via runs drawer)', () => {
    it('cancelling a non-terminal run opens a confirm dialog, then calls cancelAdminWorkflowRun on confirm', async () => {
      const user = userEvent.setup();
      render(<WorkflowsSettingsPage />, { wrapperOptions: { user: adminUser } });

      await waitFor(() => expect(screen.getByText('Screenshot cleanup')).toBeInTheDocument());
      await openWorkflowRowMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /^runs$/i }));
      await waitFor(() => expect(screen.getByRole('heading', { name: /run history/i })).toBeInTheDocument());

      // Cancel is the drawer table's ONLY row action, so it renders as a bare
      // icon button named after its row (the run's short id) — §17.6.
      await user.click(await screen.findByRole('button', { name: 'Cancel run for run-1' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/cancel this run\?/i)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /cancel run/i }));

      await waitFor(() => expect(mockCancelRun).toHaveBeenCalledWith('run-1'));
      await waitFor(() => {
        expect(screen.getByText(/run cancelled/i)).toBeInTheDocument();
      });
    });
  });
});

/**
 * RTL tests for WorkflowsOversightTable — post-#261 (the shared-DataTable
 * migration, epic #238).
 *
 * Scope note, per docs/specs/datatable.md §17.8 / §18.5: TABLE MECHANICS are a
 * property of the shared component and are covered end to end by
 * `runDataTableConformanceSuite` — pagination/sort/selection round-trips, the
 * negative "never filters rows locally" test, loading/empty/error overlays,
 * column visibility and density, CSV escaping, the issue #243
 * invisible-but-tappable sweep, and axe in both renderers and both themes.
 * None of that is re-tested here.
 *
 * What IS here is what this migration could break:
 *   - the column set: what each priority band renders, and that the row-unique
 *     column leads (so per-row controls are nameable, §17.6),
 *   - the row actions and their PERMISSION gate, which #261 moved from a
 *     disabled button onto the action ARRAY (§13.1),
 *   - the loading contract: rows stay on screen during a background refresh,
 *   - the pagination callbacks the parent still owns.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
} from '../../../../components/datatable/__tests__/testUtils/layoutStubs';
import { WorkflowsOversightTable } from '../../../../components/workflows/admin/WorkflowsOversightTable';
import {
  buildWorkflowOversightColumns,
  lastRunSummary,
} from '../../../../components/workflows/admin/workflowsOversightColumns';
import type { AdminWorkflowListItem } from '../../../../services/adminWorkflows';
import { api } from '../../../../services/api';

function makeItem(overrides: Partial<AdminWorkflowListItem> = {}): AdminWorkflowListItem {
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
  } as AdminWorkflowListItem;
}

const baseProps = {
  loading: false,
  totalItems: 1,
  page: 0,
  pageSize: 25,
  canManage: true,
  onPageChange: vi.fn(),
  onPageSizeChange: vi.fn(),
  onDisable: vi.fn(),
  onViewRuns: vi.fn(),
};

/** The row-scoped accessible-name suffix: the first `primary` column's value. */
const ROW = 'Screenshot cleanup';

beforeAll(() => {
  // jsdom performs no layout, so MUI X measures a 0×0 viewport and renders zero
  // rows without these. Same recipe every DataTable suite uses.
  installLayoutStubs();
});

describe('WorkflowsOversightTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400); // desktop layout unless a test says otherwise
    // The layout-persistence hook reads/writes `/user-settings` (§15).
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  // =========================================================================
  // Column definitions (pure)
  // =========================================================================

  describe('column definitions', () => {
    const columns = buildWorkflowOversightColumns();
    const byId = (id: string) => columns.find((column) => column.id === id)!;

    it('leads with a row-unique primary column so per-row controls are nameable', () => {
      const firstPrimary = columns.find((column) => column.priority === 'primary')!;
      expect(firstPrimary.id).toBe('name');
      expect(firstPrimary.value!(makeItem())).toBe('Screenshot cleanup');
    });

    it('makes the enabled/disabled state a PRIMARY column, not a detail one', () => {
      expect(byId('enabled').priority).toBe('primary');
      expect(byId('enabled').value!(makeItem({ enabled: false }))).toBe('Disabled');
    });

    it('declares no sortable column — the endpoint accepts no sortBy', () => {
      expect(columns.some((column) => column.sortable)).toBe(false);
    });

    it('summarises the last run as a scalar for export and truncation', () => {
      expect(lastRunSummary(makeItem())).toBeNull();
      expect(
        lastRunSummary(
          makeItem({
            lastRun: {
              status: 'completed_with_errors',
              triggerType: 'manual',
              createdAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              matchedCount: 20,
              processedCount: 20,
              succeededCount: 15,
              failedCount: 5,
              skippedCount: 2,
            },
          } as Partial<AdminWorkflowListItem>),
        ),
      ).toBe('15 ok · 5 failed · 2 skipped');
    });
  });

  // =========================================================================
  // Rendering
  // =========================================================================

  describe('empty and loading states', () => {
    it('shows "No workflows found." when items is empty and not loading', async () => {
      render(<WorkflowsOversightTable {...baseProps} items={[]} totalItems={0} />);

      expect(await screen.findByText(/no workflows found/i)).toBeInTheDocument();
    });

    it('shows a loading overlay instead of the empty state while loading with no items yet', async () => {
      render(<WorkflowsOversightTable {...baseProps} items={[]} totalItems={0} loading />);

      expect(await screen.findByTestId('datatable-loading-overlay')).toBeInTheDocument();
      expect(screen.queryByText(/no workflows found/i)).not.toBeInTheDocument();
    });

    it('keeps existing rows on screen while a background refresh is loading', async () => {
      // The #261 regression this guards: the pre-migration table swapped itself
      // for a spinner, which unmounted the renderer on every refetch.
      render(<WorkflowsOversightTable {...baseProps} items={[makeItem()]} loading />);

      expect(await screen.findByText('Screenshot cleanup')).toBeInTheDocument();
      expect(screen.getByTestId('datatable-loading-overlay')).toBeInTheDocument();
    });
  });

  describe('row rendering', () => {
    it('renders circle name, workflow name, subject, trigger, and an Enabled chip', async () => {
      render(<WorkflowsOversightTable {...baseProps} items={[makeItem()]} />);

      const grid = await screen.findByRole('grid', { name: /all workflows/i });
      expect(await within(grid).findByText('Screenshot cleanup')).toBeInTheDocument();
      expect(within(grid).getByText('Family circle')).toBeInTheDocument();
      expect(within(grid).getByText('Media item')).toBeInTheDocument();
      expect(within(grid).getByText('Manual')).toBeInTheDocument();
      expect(within(grid).getByText('Enabled')).toBeInTheDocument();
    });

    it('renders a Disabled chip for a disabled workflow', async () => {
      render(<WorkflowsOversightTable {...baseProps} items={[makeItem({ enabled: false })]} />);

      const grid = await screen.findByRole('grid', { name: /all workflows/i });
      expect(await within(grid).findByText('Disabled')).toBeInTheDocument();
      expect(within(grid).queryByText('Enabled')).not.toBeInTheDocument();
    });

    it('renders "—" for a null circle', async () => {
      render(<WorkflowsOversightTable {...baseProps} items={[makeItem({ circle: null })]} />);

      expect(await screen.findByText('—')).toBeInTheDocument();
    });

    it('renders "Never run" when lastRun is null', async () => {
      render(<WorkflowsOversightTable {...baseProps} items={[makeItem({ lastRun: null })]} />);

      expect(await screen.findByText(/never run/i)).toBeInTheDocument();
    });

    it('renders the last-run status chip and succeeded/failed counts', async () => {
      const item = makeItem({
        lastRun: {
          status: 'completed_with_errors',
          triggerType: 'manual',
          createdAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          matchedCount: 20,
          processedCount: 20,
          succeededCount: 15,
          failedCount: 5,
          skippedCount: 0,
        },
      } as Partial<AdminWorkflowListItem>);

      render(<WorkflowsOversightTable {...baseProps} items={[item]} />);

      expect(await screen.findByText('Completed with errors')).toBeInTheDocument();
      expect(screen.getByText(/15 ok/)).toBeInTheDocument();
      expect(screen.getByText(/5 failed/)).toBeInTheDocument();
    });

    it('renders formatted matched/actioned totals', async () => {
      render(
        <WorkflowsOversightTable
          {...baseProps}
          items={[makeItem({ totals: { runs: 4, matched: 2481, actioned: 2000 } })]}
        />,
      );

      expect(await screen.findByText('2,481')).toBeInTheDocument();
      expect(screen.getByText('2,000')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Row actions + permission gating
  // =========================================================================

  describe('row actions', () => {
    async function openRowMenu(user: ReturnType<typeof userEvent.setup>) {
      await user.click(await screen.findByRole('button', { name: `Row actions for ${ROW}` }));
    }

    it('calls onViewRuns with the workflow when "Runs" is chosen', async () => {
      const user = userEvent.setup();
      const onViewRuns = vi.fn();
      const item = makeItem();
      render(<WorkflowsOversightTable {...baseProps} items={[item]} onViewRuns={onViewRuns} />);

      await openRowMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /runs/i }));

      expect(onViewRuns).toHaveBeenCalledWith(item);
    });

    it('calls onDisable with the workflow when "Disable" is chosen (canManage + enabled)', async () => {
      const user = userEvent.setup();
      const onDisable = vi.fn();
      const item = makeItem({ enabled: true });
      render(
        <WorkflowsOversightTable {...baseProps} items={[item]} canManage onDisable={onDisable} />,
      );

      await openRowMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /disable/i }));

      expect(onDisable).toHaveBeenCalledWith(item);
    });

    it('omits the Disable action entirely without system_settings:write', async () => {
      // #261 moved the permission gate from a disabled button onto the action
      // ARRAY (docs/specs/datatable.md §13.1), so the action a caller may not
      // perform is absent from the DOM rather than merely inert — and it is
      // absent in EVERY renderer, not just the grid.
      const user = userEvent.setup();
      render(
        <WorkflowsOversightTable
          {...baseProps}
          items={[makeItem({ enabled: true })]}
          canManage={false}
        />,
      );

      // One action left, so the control is a bare icon button, not a menu.
      expect(await screen.findByRole('button', { name: `Runs for ${ROW}` })).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: `Row actions for ${ROW}` }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: `Runs for ${ROW}` }));
      expect(screen.queryByRole('menuitem', { name: /disable/i })).not.toBeInTheDocument();
    });

    it('omits the Disable action in the CARD renderer too, without the permission', async () => {
      resetContainerWidth(400); // a phone-width container
      render(
        <WorkflowsOversightTable
          {...baseProps}
          items={[makeItem({ enabled: true })]}
          canManage={false}
        />,
      );

      const user = userEvent.setup();
      // On a card the actions control is ALWAYS a menu, even for one action.
      await user.click(await screen.findByRole('button', { name: `Row actions for ${ROW}` }));
      expect(screen.getByRole('menuitem', { name: /runs/i })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /disable/i })).not.toBeInTheDocument();
    });

    it('disables (but keeps) the Disable action for an already-disabled workflow', async () => {
      const user = userEvent.setup();
      render(
        <WorkflowsOversightTable
          {...baseProps}
          items={[makeItem({ enabled: false })]}
          canManage
        />,
      );

      await openRowMenu(user);
      expect(screen.getByRole('menuitem', { name: /disable/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
  });

  // =========================================================================
  // Pagination (the parent still owns the state)
  // =========================================================================

  describe('pagination', () => {
    it('reflects totalItems/page/pageSize in the footer', async () => {
      render(
        <WorkflowsOversightTable
          {...baseProps}
          items={[makeItem()]}
          totalItems={57}
          page={1}
          pageSize={25}
        />,
      );

      // page=1 (0-based) × 25 → "26–50 of 57".
      expect(await screen.findByText(/26.50 of 57/)).toBeInTheDocument();
    });

    it('calls onPageChange when the next-page control is used', async () => {
      const user = userEvent.setup();
      const onPageChange = vi.fn();
      render(
        <WorkflowsOversightTable
          {...baseProps}
          items={[makeItem()]}
          totalItems={57}
          page={0}
          pageSize={25}
          onPageChange={onPageChange}
        />,
      );

      await user.click(await screen.findByRole('button', { name: /go to next page/i }));

      expect(onPageChange).toHaveBeenCalledWith(1);
    });
  });
});
